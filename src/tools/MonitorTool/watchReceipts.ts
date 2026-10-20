import { TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js'
import type { RunnerRestartReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { OrphanedLaunch, OrphanProcessFate } from '../../tasks/taskLaunchLedger.js'
import type { Message } from '../../types/message.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { wrapInSystemReminder } from '../../utils/messages/text.js'
import { createSecretRedactor } from '../../utils/redactSecrets.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { MONITOR_TOOL_NAME } from './constants.js'

export const WATCH_STARTED_LINE = 'Monitor started (task '

interface WatchReceipt {
  toolUseId: string
  taskId: string
  description: string
  command: string
  persistent: boolean
  armedAt: number
  process?: OrphanProcessFate
}

interface BackgroundShellReceipt {
  toolUseId: string
  taskId: string
  description: string
  command: string
  outputPath: string | null
  armedAt: number
  process?: OrphanProcessFate
}

const COMMAND_WORDS_MAX = 200
const LABEL_WORDS_MAX = 60
const NAMED_MAX = 6

let redactCommandText: ((text: string) => string) | null = null

function clampWords(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

function commandWords(command: string): string {
  redactCommandText ??= createSecretRedactor()
  return clampWords(redactCommandText(command).replace(/\s+/g, ' ').trim(), COMMAND_WORDS_MAX)
}

function labelWords(description: string): string {
  return clampWords(description.replace(/\s+/g, ' ').replace(/"/g, "'").trim(), LABEL_WORDS_MAX)
}

export function monitorNoticeBlock(taskId: string, description: string, text: string, summary?: { count: number; last: string }): string {
  const detail = summary === undefined || summary.count <= 1 ? '' : ` lines=${JSON.stringify(summary.count)} last=${JSON.stringify(summary.last)}`
  return `<monitor task=${JSON.stringify(taskId)} name=${JSON.stringify(description)}${detail}>\n${text}\n</monitor>`
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
const SHELL_OUTPUT_PATH = /Output: (\S+\.output)/
const DEAD_SHELL = /\[Background shell (\S+?)(?: "[^"\n]*")? did not survive/g
const DEAD_SHELLS = /\[Background shells (\S+?(?:, \S+?)*) did not survive/g

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

function backgroundShellReceipts(messages: readonly Message[]): BackgroundShellReceipt[] {
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
      receipts.push({ toolUseId: block.tool_use_id, taskId, ...launch, outputPath: SHELL_OUTPUT_PATH.exec(text)?.[1] ?? null })
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
    for (const match of text.matchAll(DEAD_SHELL)) {
      if (match[1]) settled.add(match[1])
    }
    for (const match of text.matchAll(DEAD_SHELLS)) {
      for (const taskId of (match[1] ?? '').split(', ')) if (taskId !== '') settled.add(taskId)
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

function fatesOf(ledger: readonly OrphanedLaunch[], ended: ReadonlySet<string>): Map<string, OrphanProcessFate> {
  const fates = new Map<string, OrphanProcessFate>()
  for (const taskId of ended) fates.set(taskId, 'gone')
  for (const orphan of ledger) fates.set(orphan.record.taskId, orphan.process)
  return fates
}

export function orphanedWatches(messages: readonly Message[], liveTaskIds: ReadonlySet<string>, ledger: readonly OrphanedLaunch[] = [], ended: ReadonlySet<string> = new Set()): WatchReceipt[] {
  const settled = settledWatchIds(messages)
  const fates = fatesOf(ledger, ended)
  const fromTranscript = watchReceipts(messages)
    .filter(receipt => !settled.has(receipt.taskId) && !liveTaskIds.has(receipt.taskId))
    .map(receipt => (fates.has(receipt.taskId) ? { ...receipt, process: fates.get(receipt.taskId)! } : receipt))
  const named = new Set(fromTranscript.map(receipt => receipt.taskId))
  const fromLedger = ledger
    .filter(orphan => orphan.record.kind === 'monitor' && !named.has(orphan.record.taskId) && !liveTaskIds.has(orphan.record.taskId))
    .map(orphan => ({
      toolUseId: orphan.record.toolUseId,
      taskId: orphan.record.taskId,
      description: orphan.record.description,
      command: orphan.record.command,
      persistent: orphan.record.persistent,
      armedAt: orphan.record.armedAt,
      process: orphan.process,
    }))
  return [...fromTranscript, ...fromLedger].sort((a, b) => a.armedAt - b.armedAt)
}

function orphanedBackgroundShells(messages: readonly Message[], liveTaskIds: ReadonlySet<string>, ledger: readonly OrphanedLaunch[] = [], ended: ReadonlySet<string> = new Set()): BackgroundShellReceipt[] {
  const settled = settledWatchIds(messages)
  const fates = fatesOf(ledger, ended)
  const fromTranscript = backgroundShellReceipts(messages)
    .filter(receipt => !settled.has(receipt.taskId) && !settled.has(receipt.toolUseId) && !liveTaskIds.has(receipt.taskId))
    .map(receipt => (fates.has(receipt.taskId) ? { ...receipt, process: fates.get(receipt.taskId)! } : receipt))
  const named = new Set(fromTranscript.map(receipt => receipt.taskId))
  const fromLedger = ledger
    .filter(orphan => orphan.record.kind === 'shell' && !named.has(orphan.record.taskId) && !liveTaskIds.has(orphan.record.taskId))
    .map(orphan => ({
      toolUseId: orphan.record.toolUseId,
      taskId: orphan.record.taskId,
      description: orphan.record.description,
      command: orphan.record.command,
      outputPath: orphan.record.outputPath,
      armedAt: orphan.record.armedAt,
      process: orphan.process,
    }))
  return [...fromTranscript, ...fromLedger].sort((a, b) => a.armedAt - b.armedAt)
}

function processFateWords(fate: OrphanProcessFate | undefined): string {
  return fate === 'ended'
    ? 'its process had outlived the session and was ended just now'
    : fate === 'gone'
      ? 'its process ended with the session'
      : fate === 'unconfirmed'
        ? 'a process still runs under its pid but could not be confirmed as this one and was left alone'
        : 'its process is no longer attached to this chat'
}

function restartEndedWords(reason?: RunnerRestartReason): string {
  return reason === 'crash'
    ? "the session's restart after a crash"
    : reason === 'stop'
      ? "the session's restart after a stop"
      : reason === 'settings'
        ? "the session's restart after a settings change"
        : reason === 'relaunch'
          ? "the session's restart after a relaunch"
          : reason === 'update'
            ? "the session's restart after an update"
            : reason === 'ended'
              ? "the session's restart after it ended around an update"
              : "the session's pause"
}

export function deadWatchLine(receipt: WatchReceipt, reason?: RunnerRestartReason): string {
  const cmd = commandWords(receipt.command)
  return `[Monitor "${receipt.description}" (task ${receipt.taskId}) did not survive ${restartEndedWords(reason)}: ${processFateWords(receipt.process)}, so nothing it would have reported since then is known. Start it again by calling Monitor with the same command${cmd !== '' ? ` (${cmd})` : ''} if the watch is still wanted.]`
}

function deadShellLine(receipt: BackgroundShellReceipt, reason?: RunnerRestartReason): string {
  const cmd = commandWords(receipt.command)
  const desc = labelWords(receipt.description)
  const kept = receipt.outputPath !== null ? `; what it printed until then stays in ${receipt.outputPath}` : ''
  return `[Background shell ${receipt.taskId}${desc !== '' ? ` "${desc}"` : ''} did not survive ${restartEndedWords(reason)}: ${processFateWords(receipt.process)}${kept}. Start it again by running Bash with the same command${cmd !== '' ? ` (${cmd})` : ''} if it is still wanted.]`
}

function moreShellsLine(receipts: readonly BackgroundShellReceipt[], reason?: RunnerRestartReason): string {
  return `[Background shells ${receipts.map(r => r.taskId).join(', ')} did not survive ${restartEndedWords(reason)} either (${receipts.length} more, named here by task id only). Restart any that is still wanted by running Bash again with its command.]`
}

export function composeRestartLine(opts: {
  reason: 'update' | 'ended'
  build: string
  watches: readonly WatchReceipt[]
  shells: readonly BackgroundShellReceipt[]
}): string {
  const items: string[] = []
  for (const w of opts.watches) {
    const cmd = commandWords(w.command)
    items.push(`Monitor «${labelWords(w.description)}»${cmd !== '' ? ` (${cmd})` : ''}`)
  }
  for (const s of opts.shells) {
    const cmd = commandWords(s.command)
    const desc = labelWords(s.description)
    items.push(`background shell «${s.taskId}»${desc !== '' ? ` "${desc}"` : ''}${cmd !== '' ? ` (${cmd})` : ''}`)
  }
  const shown = items.slice(0, NAMED_MAX)
  const more = items.length - shown.length
  const endedText = items.length === 0 ? 'none (0)' : `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''} (${items.length})`
  return opts.reason === 'update'
    ? `Mercury updated to ${opts.build} · this chat restarted · ended by the restart: ${endedText} · restart any watches or background commands you still need`
    : `This chat's process ended around an update to ${opts.build} — the cause is not known · ended with it: ${endedText} · restart any watches or background commands you still need`
}

export function endingWorkWords(rows: ReadonlyArray<{ id: string; kind: string; name: string; status: string; description?: string; command?: string }>): string {
  const items: string[] = []
  for (const row of rows) {
    if (row.status !== 'running' && row.status !== 'pending') continue
    const cmd = commandWords(row.command ?? row.name)
    const desc = labelWords(row.description ?? '')
    if (row.kind === 'monitor') items.push(`Monitor «${desc !== '' ? desc : row.id}»${cmd !== '' ? ` (${cmd})` : ''}`)
    else if (row.kind === 'shell') items.push(`background shell «${row.id}»${desc !== '' ? ` "${desc}"` : ''}${cmd !== '' ? ` (${cmd})` : ''}`)
  }
  if (items.length === 0) return 'no watches or background shells'
  const shown = items.slice(0, NAMED_MAX)
  const more = items.length - shown.length
  return `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''} (${items.length})`
}

export function composeBuildBehindLine(installedTree: string, runningTree: string, newer: boolean): string {
  return `${newer ? 'A newer' : 'Another'} Mercury build is installed (${installedTree}). This chat still uses ${runningTree}. /restart switches to it; watches and background shells will stop and be listed.`
}

export function reconcileWatchesOnResume(
  messages: readonly Message[],
  liveTaskIds: ReadonlySet<string>,
  reason?: RunnerRestartReason,
  ledger: readonly OrphanedLaunch[] = [],
  ended: ReadonlySet<string> = new Set(),
): WatchReceipt[] {
  const orphans = orphanedWatches(messages, liveTaskIds, ledger, ended)
  for (const receipt of orphans) {
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
  ledger: readonly OrphanedLaunch[] = [],
  ended: ReadonlySet<string> = new Set(),
): BackgroundShellReceipt[] {
  const orphans = orphanedBackgroundShells(messages, liveTaskIds, ledger, ended)
  const named = orphans.slice(-NAMED_MAX)
  const rest = orphans.slice(0, orphans.length - named.length)
  const lines = [...named.map(receipt => deadShellLine(receipt, reason)), ...(rest.length > 0 ? [moreShellsLine(rest, reason)] : [])]
  for (const line of lines) {
    enqueuePendingNotification({
      value: wrapInSystemReminder(line),
      mode: 'task-notification',
      priority: 'next',
      ridesNextWords: true,
    })
  }
  return orphans
}
