import { TASK_ID_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js'
import type { RunnerRestartReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { Message } from '../../types/message.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { MONITOR_TOOL_NAME } from './constants.js'

export const WATCH_STARTED_LINE = 'Monitor started (task '

export interface WatchReceipt {
  toolUseId: string
  taskId: string
  description: string
  command: string
  persistent: boolean
  armedAt: number
}

export function monitorNoticeBlock(taskId: string, description: string, text: string): string {
  return `<monitor task=${JSON.stringify(taskId)} name=${JSON.stringify(description)}>\n${text}\n</monitor>`
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

const STARTED_TASK = /^Monitor started \(task (\S+?)[,)]/
const MONITOR_BLOCK = /<monitor task=("(?:[^"\\]|\\.)*")[^>]*>([\s\S]*?)<\/monitor>/g
const ENDED_WORDS = ['[Monitor "', '[Monitor stopped']

export function watchReceipts(messages: readonly Message[]): WatchReceipt[] {
  const launches = new Map<string, { description: string; command: string; persistent: boolean; armedAt: number }>()
  const receipts: WatchReceipt[] = []
  for (const message of messages) {
    if (message.type === 'assistant') {
      const stamp = Date.parse(message.timestamp)
      for (const block of blocksOf(message.message.content)) {
        if (block.type !== 'tool_use' || block.name !== MONITOR_TOOL_NAME || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as { description?: unknown; command?: unknown; persistent?: unknown }
        launches.set(block.id, {
          description: typeof input.description === 'string' ? input.description : 'monitor',
          command: typeof input.command === 'string' ? input.command : '',
          persistent: input.persistent === true || input.persistent === 'true',
          armedAt: Number.isFinite(stamp) ? stamp : Date.now(),
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
      if (!text.startsWith(WATCH_STARTED_LINE)) continue
      const taskId = STARTED_TASK.exec(text)?.[1]
      if (taskId === undefined) continue
      receipts.push({ toolUseId: block.tool_use_id, taskId, ...launch })
    }
  }
  return receipts
}

export function settledWatchIds(messages: readonly Message[]): Set<string> {
  const settled = new Set<string>()
  const taskIdTag = new RegExp(`<${TASK_ID_TAG}>([\\s\\S]*?)</${TASK_ID_TAG}>`, 'g')
  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of blocksOf(message.message.content)) {
        if (block.type !== 'tool_use' || block.name !== TASK_STOP_TOOL_NAME) continue
        const input = (block.input ?? {}) as { task_id?: unknown; shell_id?: unknown }
        for (const id of [input.task_id, input.shell_id]) {
          if (typeof id === 'string' && id !== '') settled.add(id)
        }
      }
      continue
    }
    if (message.type !== 'user') continue
    const text = textOf(message.message.content)
    if (text.includes(`<${TASK_NOTIFICATION_TAG}>`)) {
      for (const match of text.matchAll(taskIdTag)) {
        const taskId = match[1]?.trim()
        if (taskId) settled.add(taskId)
      }
    }
    for (const match of text.matchAll(MONITOR_BLOCK)) {
      const body = match[2] ?? ''
      if (!ENDED_WORDS.some(words => body.includes(words))) continue
      try {
        const taskId = JSON.parse(match[1]!) as unknown
        if (typeof taskId === 'string' && taskId !== '') settled.add(taskId)
      } catch {
      }
    }
  }
  return settled
}

export function orphanedWatches(messages: readonly Message[], liveTaskIds: ReadonlySet<string>): WatchReceipt[] {
  const settled = settledWatchIds(messages)
  return watchReceipts(messages).filter(receipt => !settled.has(receipt.taskId) && !liveTaskIds.has(receipt.taskId))
}

export function deadWatchLine(receipt: WatchReceipt, reason?: RunnerRestartReason): string {
  const ended =
    reason === 'crash'
      ? "the runner's restart after a crash"
      : reason === 'settings'
        ? "the runner's restart after a settings change"
        : reason === 'relaunch'
          ? "the runner's restart after a relaunch"
          : "the session's pause"
  return `[Monitor "${receipt.description}" (task ${receipt.taskId}) did not survive ${ended}: its process ended with the runner, so nothing it would have reported since then is known. Re-arm it by calling Monitor again with the same command if the watch is still wanted.]`
}

export function reconcileWatchesOnResume(
  messages: readonly Message[],
  liveTaskIds: ReadonlySet<string>,
  reason?: RunnerRestartReason,
): WatchReceipt[] {
  const orphans = orphanedWatches(messages, liveTaskIds)
  for (const receipt of orphans) {
    enqueuePendingNotification({
      value: monitorNoticeBlock(receipt.taskId, receipt.description, deadWatchLine(receipt, reason)),
      mode: 'task-notification',
      priority: 'next',
    })
  }
  return orphans
}
