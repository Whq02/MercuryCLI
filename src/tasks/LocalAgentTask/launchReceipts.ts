// launchReceipts — a background agent's LAUNCH RECEIPT in the transcript can
// never stand without a live record or a death notice.
//
// A background agent is an in-process task of the session's runner. Its
// launch leaves a durable receipt in the transcript (the Agent tool's
// "launched in the background" result) and its end leaves a durable notice
// (the <task-notification> row the model reads). When the runner dies
// between the two — a crash-respawn, a reactivate, a plain --resume boot —
// the agent dies with the process and the notice is never written: the next
// model reads "launched, nothing delivered", believes the agent is still
// working, and launches another. The registry (mercury://agent), the rail
// and the Crew view read the fresh runner's empty task store and disagree
// with the transcript.
//
// This module is the ONE reconciliation: at every resume road the runner
// walks the loaded transcript, pairs each launch receipt with its notice or
// a live record, and for every orphan writes the death notice — a settled
// (stopped) record in the task store for the panel grace, so the registry,
// rail and Crew view agree with the transcript, and the typed notification
// the model reads on its next turn. The notice carries the launch's own
// tool-use id, so a later resume finds it settled and never repeats it.
//
// Pure over the transcript except for the two writes at the end
// (reconcileBackgroundLaunchesOnResume), which ride the existing owners:
// the task-store record shape and enqueueAgentNotification.

import { createTaskStateBase } from '../../Task.js'
import { TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { PANEL_GRACE_MS } from '../../utils/task/framework.js'
import { notifyTasksUpdated } from '../../utils/tasks.js'
import { enqueueAgentNotification, type LocalAgentTaskState } from './LocalAgentTask.js'

/** The first line of the Agent tool's background-launch result — the
 *  receipt's own spelling (AgentTool.tsx writes it; this module reads it). */
export const BACKGROUND_LAUNCH_LINE = 'Agent launched in the background.'

export interface BackgroundLaunchReceipt {
  /** The Agent tool_use that launched it — the pairing key every notice carries. */
  toolUseId: string
  /** The agent's own id (the task id); the tool-use id when the receipt names none. */
  agentId: string
  description: string
  prompt: string
  agentType: string
  /** When the launch landed (the assistant row's clock). */
  launchedAt: number
}

/** The model-facing summary of a launch the runner's restart orphaned. */
export function restartStopSummary(description: string): string {
  return `Agent "${description}" was stopped — the session's runner restarted before it finished, so nothing it started will be delivered; relaunch it if the result is still wanted`
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; text?: string }

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

/** The text of a content value: a string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

function pickTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim()
}

/** Every background launch the transcript carries a receipt for, in order. */
export function backgroundLaunchReceipts(messages: readonly Message[]): BackgroundLaunchReceipt[] {
  const launches = new Map<string, { description: string; prompt: string; agentType: string; launchedAt: number }>()
  const receipts: BackgroundLaunchReceipt[] = []
  for (const message of messages) {
    if (message.type === 'assistant') {
      const stamp = Date.parse(message.timestamp)
      for (const block of blocksOf(message.message.content)) {
        if (block.type !== 'tool_use' || block.name !== AGENT_TOOL_NAME || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as { description?: unknown; prompt?: unknown; subagent_type?: unknown }
        launches.set(block.id, {
          description: typeof input.description === 'string' ? input.description : 'agent',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
          launchedAt: Number.isFinite(stamp) ? stamp : Date.now(),
        })
      }
      continue
    }
    if (message.type !== 'user') continue
    for (const block of blocksOf(message.message.content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const launch = launches.get(block.tool_use_id)
      if (launch === undefined) continue
      const text = textOf(block.content)
      if (!text.startsWith(BACKGROUND_LAUNCH_LINE)) continue
      const agentId = text.match(/agentId: (\S+)/)?.[1] ?? block.tool_use_id
      receipts.push({ toolUseId: block.tool_use_id, agentId, ...launch })
    }
  }
  return receipts
}

/** The launches the transcript already settled: every tool-use id and task
 *  id a <task-notification> row names (completed, failed or stopped alike). */
export function settledLaunchIds(messages: readonly Message[]): Set<string> {
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const text = textOf(message.message.content)
    if (!text.includes(`<${TASK_NOTIFICATION_TAG}>`)) continue
    const toolUseId = pickTag(text, TOOL_USE_ID_TAG)
    const taskId = pickTag(text, TASK_ID_TAG)
    if (toolUseId) settled.add(toolUseId)
    if (taskId) settled.add(taskId)
  }
  return settled
}

/** The receipts with neither a notice in the transcript nor a record in the
 *  registry — the launches a restart orphaned. */
export function orphanedBackgroundLaunches(
  messages: readonly Message[],
  liveTaskIds: ReadonlySet<string>,
): BackgroundLaunchReceipt[] {
  const settled = settledLaunchIds(messages)
  return backgroundLaunchReceipts(messages).filter(
    receipt =>
      !settled.has(receipt.toolUseId) &&
      !settled.has(receipt.agentId) &&
      !liveTaskIds.has(receipt.agentId) &&
      !liveTaskIds.has(receipt.toolUseId),
  )
}

/** The settled record an orphaned launch gets — the store's own stop word,
 *  settled through the panel grace like every stopped agent. */
export function stoppedRecordFor(receipt: BackgroundLaunchReceipt, now: number = Date.now()): LocalAgentTaskState {
  return {
    ...createTaskStateBase(receipt.agentId, 'local_agent', receipt.description, receipt.toolUseId),
    type: 'local_agent',
    agentId: receipt.agentId,
    prompt: receipt.prompt,
    agentType: receipt.agentType,
    status: 'killed',
    startTime: receipt.launchedAt,
    endTime: now,
    isBackgrounded: true,
    // The eviction gate keys on the retain field's PRESENCE: a record
    // without one is evicted the moment it is notified, and the rail, the
    // Crew view and the registry would never show the stop. Present and
    // false, the deadline below is the one that counts.
    retain: false,
    evictAfter: now + PANEL_GRACE_MS,
    error: 'stopped by a runner restart',
  }
}

/**
 * THE RECONCILIATION at a resume: every orphaned launch gets its settled
 * record and its death notice, once. Returns the receipts it settled.
 */
export function reconcileBackgroundLaunchesOnResume(
  messages: readonly Message[],
  getAppState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  now: number = Date.now(),
): BackgroundLaunchReceipt[] {
  const live = new Set(Object.keys(getAppState().tasks ?? {}))
  const orphans = orphanedBackgroundLaunches(messages, live)
  if (orphans.length === 0) return []
  setAppState(prev => {
    const tasks = { ...prev.tasks }
    for (const receipt of orphans) tasks[receipt.agentId] = stoppedRecordFor(receipt, now)
    return { ...prev, tasks }
  })
  notifyTasksUpdated()
  for (const receipt of orphans) {
    enqueueAgentNotification({
      taskId: receipt.agentId,
      description: receipt.description,
      status: 'killed',
      error: 'stopped by a runner restart',
      setAppState,
      toolUseId: receipt.toolUseId,
      summary: restartStopSummary(receipt.description),
    })
  }
  return orphans
}
