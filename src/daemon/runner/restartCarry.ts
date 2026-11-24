import { randomUUID, type UUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import {
  CREWMATE_RELAUNCH_NOTE,
  heldCrewmateNotices,
  orphanedBackgroundLaunches,
  queueLogRows,
  queuedNoticeIds,
  restartCarryRow,
  settledRecordFor,
  undeliveredLines,
  type BackgroundLaunchReceipt,
  type HeldCrewmateNotice,
  type RestartCarryCounts,
  type RunnerRestartReason,
} from '../../engine/tasks/local-agent/launchReceipts.js'
import type { CanUseToolFn, ToolUseContext } from '../../tools/kit/tool.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import type { AgentId } from '../../sessions/transcripts/ids.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getErrnoCode, isENOENT } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { saturnQueueStamp, screenCommandQueueStamp } from '../../engine/message-shapes/noticeRows.js'
import { wrapInSystemReminder } from '../../engine/message-shapes/text.js'
import { enqueue, enqueuePendingNotification } from '../../screen/composer/input-core/command-queue.js'
import { emitTaskEnded } from './sdkEventQueue.js'
import { MAX_TRANSCRIPT_READ_BYTES, getTranscriptPath, readCrewmateMetadata } from '../../sessions/transcripts/paths.js'
import { historyTail } from '../../sessions/transcripts/historyParts.js'
import { notifyTasksUpdated } from '../../engine/task-framework/tasks.js'

type RestartCarryPorts = {
  reason: RunnerRestartReason
  messages: readonly Message[]
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  canUseTool: CanUseToolFn
  relaunchContext: () => Promise<ToolUseContext>
  transcriptPath?: string
  now?: number
}

type RestartCarryOutcome = RestartCarryCounts & { requeued: number; recoveredCommandIds: string[]; row: string | null }

function transcriptTailLines(path: string): string[] {
  try {
    return historyTail(path, MAX_TRANSCRIPT_READ_BYTES).bytes.toString('utf8').split('\n')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
}

async function crewmateFolderStands(agentId: string): Promise<boolean> {
  let meta: Awaited<ReturnType<typeof readCrewmateMetadata>> = null
  try {
    meta = await readCrewmateMetadata(agentId as AgentId)
  } catch (error) {
    logForDebugging(`[session-runner] restart carry: metadata read failed for agent ${agentId} — ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
  const folder = meta?.worktreePath ?? meta?.cwd
  if (folder === undefined) return true
  try {
    return statSync(folder).isDirectory()
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    logForDebugging(`[session-runner] restart carry: stat failed for agent ${agentId} folder ${folder} (${code ?? 'unknown'}) — ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
}

function relaunchNoteFor(held: HeldCrewmateNotice | undefined): string {
  if (held?.landedWrites === undefined) return CREWMATE_RELAUNCH_NOTE
  return `${CREWMATE_RELAUNCH_NOTE} Before the restart, ${held.landedWrites}.`
}

export function requeueUndeliveredLines(lines: Iterable<string>, recoveredCommandIds: string[] = []): number {
  let requeued = 0
  for (const row of undeliveredLines(queueLogRows(lines))) {
    const uuid = (row.uuid ?? randomUUID()) as UUID
    const command: QueuedCommand = {
      value: row.content ?? '',
      mode: row.mode === 'bash' ? 'bash' : 'prompt',
      priority: 'next',
      uuid,
      ...(row.sentAt !== undefined ? { sentAt: row.sentAt } : row.at !== undefined ? { sentAt: row.at } : {}),
      ...saturnQueueStamp(row.origin),
      ...screenCommandQueueStamp(row.origin),
    } as QueuedCommand
    enqueue(command)
    recoveredCommandIds.push(uuid)
    requeued++
  }
  return requeued
}

export async function carryRunnerAcrossRestart(ports: RestartCarryPorts): Promise<RestartCarryOutcome> {
  const lines = transcriptTailLines(ports.transcriptPath ?? getTranscriptPath())
  const recoveredCommandIds: string[] = []
  const requeued = requeueUndeliveredLines(lines, recoveredCommandIds)
  const orphans = orphanedBackgroundLaunches(ports.messages, new Set(Object.keys(ports.getAppState().tasks ?? {})))
  if (orphans.length === 0) {
    return { relaunched: 0, delivered: 0, stopped: 0, requeued, recoveredCommandIds, row: null }
  }
  const now = ports.now ?? Date.now()
  const noticed = queuedNoticeIds(ports.messages)
  const open = orphans.filter(receipt => !noticed.has(receipt.agentId) && !noticed.has(receipt.toolUseId))
  const held = heldCrewmateNotices(lines, new Set(open.map(receipt => receipt.agentId)))
  const deliveries: Array<{ receipt: BackgroundLaunchReceipt; notice: HeldCrewmateNotice }> = []
  let relaunched = 0
  let context: ToolUseContext | undefined
  for (const receipt of open) {
    const notice = held.get(receipt.agentId)
    const finished = notice !== undefined && (notice.status !== 'killed' || notice.operatorStop)
    if (finished) {
      deliveries.push({ receipt, notice })
      continue
    }
    let relaunchedThisOne = false
    if (await crewmateFolderStands(receipt.agentId)) {
      try {
        context ??= await ports.relaunchContext()
        const { resumeAgentBackground } = await import('../../tools/crewmate/resumeCrewmate.js')
        await resumeAgentBackground({
          agentId: receipt.agentId,
          prompt: relaunchNoteFor(notice),
          toolUseContext: { ...context, toolUseId: receipt.toolUseId, abortController: new AbortController() },
          canUseTool: ports.canUseTool,
        })
        relaunchedThisOne = true
        relaunched++
      } catch (error) {
        logError(error)
        logForDebugging(`[session-runner] restart carry: agent ${receipt.agentId} could not be relaunched — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!relaunchedThisOne && notice !== undefined) deliveries.push({ receipt, notice })
  }
  if (deliveries.length > 0) {
    ports.setAppState(prev => {
      const tasks = { ...prev.tasks }
      for (const { receipt, notice } of deliveries) tasks[receipt.agentId] = settledRecordFor(receipt, notice.status, now)
      return { ...prev, tasks }
    })
    notifyTasksUpdated()
  }
  const delivered = deliveries.filter(({ notice }) => notice.status !== 'killed').length
  const counts: RestartCarryCounts = {
    relaunched,
    delivered,
    stopped: orphans.length - relaunched - delivered,
  }
  const row = restartCarryRow(ports.reason, counts)
  enqueuePendingNotification({ value: wrapInSystemReminder(row), mode: 'task-notification', priority: 'next', ridesNextWords: true })
  for (const { receipt, notice } of deliveries) {
    if (notice.status !== 'killed') emitTaskEnded(receipt.agentId, notice.status, { toolUseId: receipt.toolUseId, summary: receipt.description })
    enqueuePendingNotification({ value: notice.value, mode: 'task-notification', priority: 'next', ridesNextWords: true, ...(notice.at !== undefined ? { sentAt: notice.at } : {}), ...(notice.agentCompletion !== undefined ? { agentCompletion: notice.agentCompletion } : {}) })
  }
  return { ...counts, requeued, recoveredCommandIds, row }
}
