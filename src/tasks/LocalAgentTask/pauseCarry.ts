import { readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createTaskStateBase, type SetAppState } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import { asAgentId } from '../../types/ids.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getAgentMetadataPath, getTranscriptPath, readAgentMetadata } from '../../utils/sessionStorage/paths.js'
import { notifyTasksUpdated } from '../../utils/tasks.js'
import { decodeAgentPause, type AgentPauseV1 } from './agentPause.js'
import { AGENT_WINDOW_RESUME_NOTE, isLocalAgentTask, type LocalAgentTaskState } from './LocalAgentTask.js'

export type AgentPauseRecordV1 = {
  pause: AgentPauseV1 & { resumesAtMs: number }
  description: string
  armedAt: number
  toolUseId?: string
}

export function agentPauseRecordPath(agentId: string): string {
  return getAgentMetadataPath(asAgentId(agentId)).replace(/\.meta\.json$/, '.pause.json')
}

const writesInFlight = new Map<string, Promise<void>>()

export async function writeAgentPauseRecord(agentId: string, record: AgentPauseRecordV1): Promise<void> {
  const previous = writesInFlight.get(agentId) ?? Promise.resolve()
  const write: Promise<void> = previous.catch(() => undefined).then(() => durableAtomicPublish(agentPauseRecordPath(agentId), JSON.stringify(record))).then(() => undefined)
  writesInFlight.set(agentId, write)
  try {
    await write
  } finally {
    if (writesInFlight.get(agentId) === write) writesInFlight.delete(agentId)
  }
}

export async function clearAgentPauseRecord(agentId: string): Promise<void> {
  await writesInFlight.get(agentId)?.catch(() => undefined)
  try {
    await unlink(agentPauseRecordPath(agentId))
  } catch (failure) {
    if (!isFsInaccessible(failure)) throw failure
  }
}

export function decodeAgentPauseRecord(raw: unknown): AgentPauseRecordV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const pause = decodeAgentPause(record.pause)
  if (pause === null || pause.resumesAtMs === undefined || typeof record.description !== 'string' || typeof record.armedAt !== 'number' || !Number.isFinite(record.armedAt)) return null
  return {
    pause: { ...pause, resumesAtMs: pause.resumesAtMs },
    description: record.description,
    armedAt: record.armedAt,
    ...(typeof record.toolUseId === 'string' && record.toolUseId !== '' ? { toolUseId: record.toolUseId } : {}),
  }
}

export async function readAgentPauseRecord(agentId: string): Promise<AgentPauseRecordV1 | null> {
  let bytes: string
  try {
    bytes = await readFile(agentPauseRecordPath(agentId), 'utf-8')
  } catch (failure) {
    if (!isFsInaccessible(failure)) throw failure
    return null
  }
  try {
    return decodeAgentPauseRecord(JSON.parse(bytes))
  } catch {
    return null
  }
}

export async function listAgentPauseRecords(): Promise<Array<{ agentId: AgentId; record: AgentPauseRecordV1 }>> {
  const directory = join(dirname(getTranscriptPath()), String(getSessionId()), 'subagents')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (failure) {
    if (!isFsInaccessible(failure)) throw failure
    return []
  }
  const rows: Array<{ agentId: AgentId; record: AgentPauseRecordV1 }> = []
  for (const name of names) {
    const match = /^agent-(.+)\.pause\.json$/.exec(name)
    if (!match) continue
    const agentId = asAgentId(match[1]!)
    const record = await readAgentPauseRecord(agentId).catch(() => null)
    if (record !== null) rows.push({ agentId, record })
  }
  return rows.sort((a, b) => a.record.armedAt - b.record.armedAt)
}

export type PauseCarryPorts = {
  getAppState: () => AppState
  setAppState: SetAppState
  canUseTool?: CanUseToolFn
  relaunchContext: () => Promise<ToolUseContext>
  now?: number
}

export async function carryPausedCrewmatesOnResume(ports: PauseCarryPorts): Promise<string[]> {
  const records = await listAgentPauseRecords()
  if (records.length === 0) return []
  const now = ports.now ?? Date.now()
  const { armBudgetCutResume, windowPauseResumeDelayMs } = await import('../../tools/AgentTool/agentToolUtils.js')
  const carried: string[] = []
  let context: ToolUseContext | undefined
  for (const { agentId, record } of records) {
    const standing = ports.getAppState().tasks?.[agentId]
    if (isLocalAgentTask(standing) && standing.status === 'running') {
      await clearAgentPauseRecord(agentId).catch(() => undefined)
      continue
    }
    const metadata = await readAgentMetadata(agentId).catch(() => null)
    const registration = new AbortController()
    ports.setAppState(prev => {
      const previous = prev.tasks[agentId]
      const base = isLocalAgentTask(previous)
        ? previous
        : {
            ...createTaskStateBase({ task_id: agentId, task_type: 'local_agent', description: record.description, call_id: record.toolUseId ?? '' }),
            type: 'local_agent' as const,
            agentId,
            prompt: '',
            agentType: metadata?.agentType ?? 'mercury-crew',
            startTime: metadata?.launchedAt ?? record.armedAt,
            isBackgrounded: true,
            retain: false,
          }
      const row: LocalAgentTaskState = {
        ...base,
        status: 'failed',
        endTime: record.armedAt,
        error: record.pause.words,
        registration,
        notified: true,
        paused: record.pause,
        abortController: undefined,
      }
      return { ...prev, tasks: { ...prev.tasks, [agentId]: row } }
    })
    try {
      context ??= await ports.relaunchContext()
      const armed = armBudgetCutResume({
        taskId: agentId,
        description: record.description,
        registration,
        toolUseContext: { ...context, abortController: registration },
        rootSetAppState: ports.setAppState,
        canUseTool: ports.canUseTool,
        delayMs: windowPauseResumeDelayMs(record.pause.resumesAtMs, now),
        pause: record.pause,
        prompt: AGENT_WINDOW_RESUME_NOTE,
        summary: `Crewmate "${record.description}" resumed by itself — the usage window reset; its partial work carried forward`,
      })
      if (armed !== null) carried.push(agentId)
    } catch (error) {
      logForDebugging(`[session-runner] resume: the pause of crewmate ${agentId} could not be re-armed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (carried.length > 0) notifyTasksUpdated()
  return carried
}
