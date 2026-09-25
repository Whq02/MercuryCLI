import { randomUUID, type UUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  AGENT_RELAUNCH_NOTE,
  heldAgentNotices,
  orphanedBackgroundLaunches,
  queueLogRows,
  queuedNoticeIds,
  restartCarryRow,
  settledRecordFor,
  undeliveredLines,
  type BackgroundLaunchReceipt,
  type HeldAgentNotice,
  type RestartCarryCounts,
  type RunnerRestartReason,
} from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { enqueue, enqueuePendingNotification } from '../../input-core/command-queue.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { MAX_TRANSCRIPT_READ_BYTES, getTranscriptPath, readAgentMetadata } from '../../utils/sessionStorage/paths.js'
import { readTranscriptBytesAfter } from '../../utils/sessionStorage/transcriptReader.js'
import { notifyTasksUpdated } from '../../utils/tasks.js'

export type RestartCarryPorts = {
  reason: RunnerRestartReason
  messages: readonly Message[]
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  canUseTool: CanUseToolFn
  relaunchContext: () => Promise<ToolUseContext>
  transcriptPath?: string
  now?: number
}

export type RestartCarryOutcome = RestartCarryCounts & { requeued: number; row: string | null }

export function transcriptTailLines(path: string): string[] {
  try {
    const size = statSync(path).size
    const read = readTranscriptBytesAfter(path, { offset: Math.max(0, size - MAX_TRANSCRIPT_READ_BYTES), carry: '' })
    return [...read.text.split('\n'), read.cursor.carry]
  } catch {
    return []
  }
}

async function agentFolderStands(agentId: string): Promise<boolean> {
  const meta = await readAgentMetadata(agentId as AgentId).catch(() => null)
  const folder = meta?.worktreePath ?? meta?.cwd
  if (folder === undefined) return true
  try {
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}

function relaunchNoteFor(held: HeldAgentNotice | undefined): string {
  if (held?.landedWrites === undefined) return AGENT_RELAUNCH_NOTE
  return `${AGENT_RELAUNCH_NOTE} Before the restart, ${held.landedWrites}.`
}

export function requeueUndeliveredLines(lines: Iterable<string>): number {
  let requeued = 0
  for (const row of undeliveredLines(queueLogRows(lines))) {
    const uuid = (row.uuid ?? randomUUID()) as UUID
    const command: QueuedCommand = {
      value: row.content ?? '',
      mode: row.mode === 'bash' ? 'bash' : 'prompt',
      priority: 'next',
      uuid,
      ...(row.sentAt !== undefined ? { sentAt: row.sentAt } : row.at !== undefined ? { sentAt: row.at } : {}),
      ...(row.origin !== undefined ? { origin: row.origin } : {}),
    } as QueuedCommand
    enqueue(command)
    requeued++
  }
  return requeued
}

export async function carryRunnerAcrossRestart(ports: RestartCarryPorts): Promise<RestartCarryOutcome> {
  const lines = transcriptTailLines(ports.transcriptPath ?? getTranscriptPath())
  const requeued = requeueUndeliveredLines(lines)
  const orphans = orphanedBackgroundLaunches(ports.messages, new Set(Object.keys(ports.getAppState().tasks ?? {})))
  if (orphans.length === 0) {
    return { relaunched: 0, delivered: 0, stopped: 0, requeued, row: null }
  }
  const now = ports.now ?? Date.now()
  const noticed = queuedNoticeIds(ports.messages)
  const open = orphans.filter(receipt => !noticed.has(receipt.agentId) && !noticed.has(receipt.toolUseId))
  const held = heldAgentNotices(lines, new Set(open.map(receipt => receipt.agentId)))
  const deliveries: Array<{ receipt: BackgroundLaunchReceipt; notice: HeldAgentNotice }> = []
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
    if (await agentFolderStands(receipt.agentId)) {
      try {
        context ??= await ports.relaunchContext()
        const { resumeAgentBackground } = await import('../../tools/AgentTool/resumeAgent.js')
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
  enqueuePendingNotification({ value: row, mode: 'task-notification', priority: 'next' })
  for (const { receipt, notice } of deliveries) {
    if (notice.status !== 'killed') emitTaskTerminatedSdk(receipt.agentId, notice.status, { toolUseId: receipt.toolUseId, summary: receipt.description })
    enqueuePendingNotification({ value: notice.value, mode: 'task-notification', priority: 'next', ...(notice.at !== undefined ? { sentAt: notice.at } : {}) })
  }
  return { ...counts, requeued, row }
}
