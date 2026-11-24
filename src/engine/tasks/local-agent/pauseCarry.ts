import { readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppState } from '../../../screen/app-state/AppStateStore.js'
import { createTaskStateBase, type SetAppState } from '../taskBase.js'
import type { CanUseToolFn, ToolUseContext } from '../../../tools/kit/tool.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import { asAgentId } from '../../../sessions/transcripts/ids.js'
import { publishAtomic } from '../../../platform/substrate/fileStore.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getErrnoCode } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { getCrewmateMetadataPath, getTranscriptPath, readCrewmateMetadata } from '../../../sessions/transcripts/paths.js'
import { notifyTasksUpdated } from '../../task-framework/tasks.js'
import { decodeCrewmatePause, type CrewmatePauseV1 } from './crewmatePause.js'
import { CREWMATE_RESUME_DOOR, CREWMATE_WINDOW_RESUME_NOTE, enqueueCrewmateReceiptRow, isCrewmateTask, type CrewmateTaskState } from './crewmateTask.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

type CrewmatePauseRecordFacts = {
  description: string
  armedAt: number
  toolUseId?: string
}

type CrewmatePauseRecordV1 =
  | (CrewmatePauseRecordFacts & { pause: CrewmatePauseV1 & { resumesAtMs: number } })
  | (CrewmatePauseRecordFacts & { pause: { why: 'provider overloaded'; words: string }; model: string })

export function crewmatePauseRecordPath(agentId: string): string {
  return getCrewmateMetadataPath(asAgentId(agentId)).replace(/\.meta\.json$/, '.pause.json')
}

const writesInFlight = new Map<string, Promise<void>>()

export async function writeCrewmatePauseRecord(agentId: string, record: CrewmatePauseRecordV1): Promise<void> {
  const previous = writesInFlight.get(agentId) ?? Promise.resolve()
  const write: Promise<void> = previous.catch(passedOverAs(undefined)).then(() => publishAtomic(crewmatePauseRecordPath(agentId), JSON.stringify(record))).then(() => undefined)
  writesInFlight.set(agentId, write)
  try {
    await write
  } finally {
    if (writesInFlight.get(agentId) === write) writesInFlight.delete(agentId)
  }
}

export async function clearCrewmatePauseRecord(agentId: string): Promise<void> {
  await writesInFlight.get(agentId)?.catch(passedOverAs(undefined))
  try {
    await unlink(crewmatePauseRecordPath(agentId))
  } catch (failure) {
    const code = getErrnoCode(failure)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw failure
  }
}

function decodeCrewmatePauseRecord(raw: unknown): CrewmatePauseRecordV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const pause = decodeCrewmatePause(record.pause)
  if (pause === null || typeof record.description !== 'string' || typeof record.armedAt !== 'number' || !Number.isFinite(record.armedAt)) return null
  const facts: CrewmatePauseRecordFacts = {
    description: record.description,
    armedAt: record.armedAt,
    ...(typeof record.toolUseId === 'string' && record.toolUseId !== '' ? { toolUseId: record.toolUseId } : {}),
  }
  if (pause.resumesAtMs !== undefined) return { ...facts, pause: { ...pause, resumesAtMs: pause.resumesAtMs } }
  if (pause.why !== 'provider overloaded' || typeof record.model !== 'string' || record.model === '') return null
  return { ...facts, pause: { why: pause.why, words: pause.words }, model: record.model }
}

export async function readCrewmatePauseRecord(agentId: string): Promise<CrewmatePauseRecordV1 | null> {
  let bytes: string
  try {
    bytes = await readFile(crewmatePauseRecordPath(agentId), 'utf-8')
  } catch (failure) {
    const code = getErrnoCode(failure)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw failure
  }
  return decodeCrewmatePauseRecord(JSON.parse(bytes))
}

async function listCrewmatePauseRecords(): Promise<Array<{ agentId: AgentId; record: CrewmatePauseRecordV1 }>> {
  const directory = join(dirname(getTranscriptPath()), String(getSessionId()), 'subagents')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (failure) {
    const code = getErrnoCode(failure)
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw failure
  }
  const rows: Array<{ agentId: AgentId; record: CrewmatePauseRecordV1 }> = []
  for (const name of names) {
    const match = /^agent-(.+)\.pause\.json$/.exec(name)
    if (!match) continue
    const agentId = asAgentId(match[1]!)
    let record: CrewmatePauseRecordV1 | null
    try {
      record = await readCrewmatePauseRecord(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logError(error)
      enqueueCrewmateReceiptRow({
        taskId: agentId,
        description: agentId,
        status: 'failed',
        summary: `Crewmate "${agentId}" could not be resumed automatically (${msg}) — ${CREWMATE_RESUME_DOOR}`,
      })
      continue
    }
    if (record !== null) rows.push({ agentId, record })
  }
  return rows.sort((a, b) => a.record.armedAt - b.record.armedAt)
}

type PauseCarryPorts = {
  getAppState: () => AppState
  setAppState: SetAppState
  canUseTool?: CanUseToolFn
  relaunchContext: () => Promise<ToolUseContext>
  now?: number
}

export async function carryPausedCrewmatesOnResume(ports: PauseCarryPorts): Promise<string[]> {
  const records = await listCrewmatePauseRecords()
  if (records.length === 0) return []
  const now = ports.now ?? Date.now()
  const { armBudgetCutResume, armOverloadProbe, windowPauseResumeDelayMs } = await import('../../../tools/crewmate/crewmateLifecycle.js')
  const carried: string[] = []
  let context: ToolUseContext | undefined
  for (const { agentId, record } of records) {
    const standing = ports.getAppState().tasks?.[agentId]
    if (isCrewmateTask(standing) && standing.status === 'running') {
      await clearCrewmatePauseRecord(agentId).catch(passedOverAs(undefined))
      continue
    }
    const metadata = await readCrewmateMetadata(agentId).catch(passedOverAs(null))
    const registration = new AbortController()
    ports.setAppState(prev => {
      const previous = prev.tasks[agentId]
      const base = isCrewmateTask(previous)
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
      const row: CrewmateTaskState = {
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
      if ('model' in record) {
        const probing = armOverloadProbe({ taskId: agentId, description: record.description, registration, toolUseContext: { ...context, abortController: registration }, rootSetAppState: ports.setAppState, canUseTool: ports.canUseTool, model: record.model, pause: record.pause, afterDeath: true, recorded: true })
        if (probing !== null) carried.push(agentId)
        continue
      }
      const armed = armBudgetCutResume({
        taskId: agentId,
        description: record.description,
        registration,
        toolUseContext: { ...context, abortController: registration },
        rootSetAppState: ports.setAppState,
        canUseTool: ports.canUseTool,
        delayMs: windowPauseResumeDelayMs(record.pause.resumesAtMs, now),
        pause: record.pause,
        prompt: CREWMATE_WINDOW_RESUME_NOTE,
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
