import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js'
import type { RunnerRestartReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { Message } from '../../types/message.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { wrapInSystemReminder } from '../../utils/messages/text.js'
import { getProjectTempDir } from '../../utils/permissions/filesystem.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
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

export interface BackgroundShellReceipt {
  toolUseId: string
  taskId: string
  description: string
  command: string
  armedAt: number
}

export interface SessionTaskRecordV1 {
  taskId: string
  toolUseId: string
  kind: 'monitor' | 'bash'
  description: string
  command: string
  persistent: boolean
  armedAt: number
}

export function sessionTasksDir(sessionId: string = String(getSessionId())): string {
  return join(getProjectTempDir(), sessionId, 'tasks')
}

export function writeSessionTaskRecord(record: SessionTaskRecordV1, sessionId: string = String(getSessionId())): void {
  try {
    const dir = sessionTasksDir(sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${record.taskId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
  }
}

export function readSessionTaskRecords(sessionId: string = String(getSessionId())): SessionTaskRecordV1[] {
  try {
    const dir = sessionTasksDir(sessionId)
    const out: SessionTaskRecordV1[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<SessionTaskRecordV1>
        if (typeof parsed.taskId === 'string' && (parsed.kind === 'monitor' || parsed.kind === 'bash')) {
          out.push({
            taskId: parsed.taskId,
            toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : '',
            kind: parsed.kind,
            description: typeof parsed.description === 'string' ? parsed.description : '',
            command: typeof parsed.command === 'string' ? parsed.command : '',
            persistent: parsed.persistent === true,
            armedAt: typeof parsed.armedAt === 'number' ? parsed.armedAt : 0,
          })
        }
      } catch {
      }
    }
    return out
  } catch {
    return []
  }
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
const SHELL_TOOL_SET = new Set<string>(SHELL_TOOL_NAMES)
const STARTED_BACKGROUND_SHELL = /(?:Running in the background \(ID: (\S+?)\)|moved this command to the background as task (\S+?)[;.]|moved to the background with ID: (\S+?)[;.])/

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

export function backgroundShellReceipts(messages: readonly Message[]): BackgroundShellReceipt[] {
  const launches = new Map<string, { description: string; command: string; armedAt: number }>()
  const receipts: BackgroundShellReceipt[] = []
  const seenTaskIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'assistant') {
      const stamp = Date.parse(message.timestamp)
      for (const block of blocksOf(message.message.content)) {
        if (block.type !== 'tool_use' || typeof block.name !== 'string' || !SHELL_TOOL_SET.has(block.name) || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as { description?: unknown; command?: unknown }
        launches.set(block.id, {
          description: typeof input.description === 'string' ? input.description : '',
          command: typeof input.command === 'string' ? input.command : '',
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
      const match = STARTED_BACKGROUND_SHELL.exec(text)
      const taskId = match?.[1] ?? match?.[2] ?? match?.[3]
      if (taskId === undefined || seenTaskIds.has(taskId)) continue
      seenTaskIds.add(taskId)
      receipts.push({ toolUseId: block.tool_use_id, taskId, ...launch })
    }
  }
  return receipts
}

export function settledWatchIds(messages: readonly Message[]): Set<string> {
  const settled = new Set<string>()
  const taskIdTag = new RegExp(`<${TASK_ID_TAG}>([\\s\\S]*?)</${TASK_ID_TAG}>`, 'g')
  const toolUseIdTag = new RegExp(`<${TOOL_USE_ID_TAG}>([\\s\\S]*?)</${TOOL_USE_ID_TAG}>`, 'g')
  const readText = (text: string): void => {
    if (text.includes(`<${TASK_NOTIFICATION_TAG}>`)) {
      for (const match of text.matchAll(taskIdTag)) {
        const taskId = match[1]?.trim()
        if (taskId) settled.add(taskId)
      }
      for (const match of text.matchAll(toolUseIdTag)) {
        const toolUseId = match[1]?.trim()
        if (toolUseId) settled.add(toolUseId)
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
    for (const match of text.matchAll(/\[Background shell (?:"[^"]*" \()?(\S+?)\)? did not survive/g)) {
      const taskId = match[1]?.trim()
      if (taskId) settled.add(taskId)
    }
  }
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
    if (message.type === 'user') {
      readText(textOf(message.message.content))
      continue
    }
    if (message.type === 'attachment') {
      const attachment = message.attachment as unknown as { type?: unknown; prompt?: unknown }
      if (attachment.type === 'queued_command') readText(textOf(attachment.prompt))
    }
  }
  return settled
}

export function orphanedWatches(messages: readonly Message[], liveTaskIds: ReadonlySet<string>): WatchReceipt[] {
  const settled = settledWatchIds(messages)
  return watchReceipts(messages).filter(receipt => !settled.has(receipt.taskId) && !liveTaskIds.has(receipt.taskId))
}

export function orphanedBackgroundShells(messages: readonly Message[], liveTaskIds: ReadonlySet<string>): BackgroundShellReceipt[] {
  const settled = settledWatchIds(messages)
  return backgroundShellReceipts(messages).filter(
    receipt => !settled.has(receipt.taskId) && !settled.has(receipt.toolUseId) && !liveTaskIds.has(receipt.taskId),
  )
}

function restartEndedWords(reason?: RunnerRestartReason): string {
  return reason === 'crash'
    ? "the runner's restart after a crash"
    : reason === 'stop'
      ? "the runner's restart after a stop"
      : reason === 'settings'
        ? "the runner's restart after a settings change"
        : reason === 'relaunch'
          ? "the runner's restart after a relaunch"
          : reason === 'update'
            ? "the runner's restart after an update"
            : "the session's pause"
}

export function deadWatchLine(receipt: WatchReceipt, reason?: RunnerRestartReason): string {
  const ended = restartEndedWords(reason)
  const cmd = receipt.command.replace(/\s+/g, ' ').trim()
  const cmdClause = cmd !== '' ? ` (${cmd})` : ''
  return `[Monitor "${receipt.description}" (task ${receipt.taskId}) did not survive ${ended}: its process ended with the runner, so nothing it would have reported since then is known. Re-arm it by calling Monitor again with the same command${cmdClause} if the watch is still wanted.]`
}

export function deadShellLine(receipt: BackgroundShellReceipt, reason?: RunnerRestartReason): string {
  const ended = restartEndedWords(reason)
  const cmd = receipt.command.replace(/\s+/g, ' ').trim()
  const cmdClause = cmd !== '' ? ` (${cmd})` : ''
  const label = receipt.description !== '' ? `"${receipt.description}" (${receipt.taskId})` : receipt.taskId
  return `[Background shell ${label} did not survive ${ended}: its process ended with the runner. Re-arm it by running Bash again with the same command${cmdClause} if it is still wanted.]`
}

export function composeUpdateRestartLine(opts: {
  build: string
  watches: readonly WatchReceipt[]
  shells: readonly BackgroundShellReceipt[]
}): string {
  const items: string[] = []
  for (const w of opts.watches) {
    const cmd = w.command.replace(/\s+/g, ' ').trim()
    items.push(`Monitor «${w.description}»${cmd !== '' ? ` (${cmd})` : ''}`)
  }
  for (const s of opts.shells) {
    const cmd = s.command.replace(/\s+/g, ' ').trim()
    const desc = s.description.replace(/\s+/g, ' ').trim()
    items.push(`background shell «${s.taskId}»${desc !== '' ? ` "${desc}"` : ''}${cmd !== '' ? ` (${cmd})` : ''}`)
  }
  const count = opts.watches.length + opts.shells.length
  const endedText = count === 0 ? 'none (0)' : `${items.join(', ')} (${count})`
  return `Mercury updated to ${opts.build} · this session's runner restarted · ended by the restart: ${endedText} · re-arm what you still want`
}

export function composeNewerBuildInstalledLine(installedTree: string, runningTree: string): string {
  return `A newer Mercury build is installed (${installedTree}) · this session still runs ${runningTree} · /restart moves it (watches and background shells end and are named)`
}

export function reconcileWatchesOnResume(
  messages: readonly Message[],
  liveTaskIds: ReadonlySet<string>,
  reason?: RunnerRestartReason,
): WatchReceipt[] {
  const orphans = orphanedWatches(messages, liveTaskIds)
  for (const receipt of orphans) {
    writeSessionTaskRecord({
      taskId: receipt.taskId,
      toolUseId: receipt.toolUseId,
      kind: 'monitor',
      description: receipt.description,
      command: receipt.command,
      persistent: receipt.persistent,
      armedAt: receipt.armedAt,
    })
    enqueuePendingNotification({
      value: monitorNoticeBlock(receipt.taskId, receipt.description, deadWatchLine(receipt, reason)),
      mode: 'task-notification',
      priority: 'next',
    })
  }
  return orphans
}

export function reconcileBackgroundShellsOnResume(
  messages: readonly Message[],
  liveTaskIds: ReadonlySet<string>,
  reason?: RunnerRestartReason,
): BackgroundShellReceipt[] {
  const orphans = orphanedBackgroundShells(messages, liveTaskIds)
  for (const receipt of orphans) {
    writeSessionTaskRecord({
      taskId: receipt.taskId,
      toolUseId: receipt.toolUseId,
      kind: 'bash',
      description: receipt.description,
      command: receipt.command,
      persistent: false,
      armedAt: receipt.armedAt,
    })
    enqueuePendingNotification({
      value: wrapInSystemReminder(deadShellLine(receipt, reason)),
      mode: 'task-notification',
      priority: 'next',
      ridesNextWords: true,
    })
  }
  return orphans
}
