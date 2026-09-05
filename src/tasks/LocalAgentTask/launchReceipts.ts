
import { createTaskStateBase } from '../../Task.js'
import { TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { PANEL_GRACE_MS } from '../../utils/task/framework.js'
import { notifyTasksUpdated } from '../../utils/tasks.js'
import { enqueueAgentNotification, type LocalAgentTaskState } from './LocalAgentTask.js'

export const BACKGROUND_LAUNCH_LINE = 'Agent launched in the background.'

export interface BackgroundLaunchReceipt {
  toolUseId: string
  agentId: string
  description: string
  prompt: string
  agentType: string
  launchedAt: number
}

export function restartStopSummary(description: string): string {
  return `Agent "${description}" was stopped — the session's runner restarted before it finished, so nothing it started will be delivered; relaunch it if the result is still wanted`
}

export type BackgroundHandoverReason = 'turn-interrupted' | 'backgrounded' | 'agent-type'

export function foregroundNotKeptLine(reason: BackgroundHandoverReason): string {
  switch (reason) {
    case 'turn-interrupted':
      return 'The foreground request was not kept: the turn it ran in was interrupted, so the agent was handed to the background to finish on its own.'
    case 'backgrounded':
      return 'The foreground request was not kept: the agent was moved to the background (ctrl+b, or it ran past the foreground threshold).'
    case 'agent-type':
      return 'The foreground request was not kept: this agent type always runs in the background.'
  }
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; text?: string }

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

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
    retain: false,
    evictAfter: now + PANEL_GRACE_MS,
    error: 'stopped by a runner restart',
  }
}

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
