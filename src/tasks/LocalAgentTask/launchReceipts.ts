
import { createTaskStateBase } from '../../Task.js'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { sliceHeadAtGrapheme } from '../../utils/intl.js'
import { isSaturnOrigin, type SaturnOrigin } from '../../utils/messages/noticeRows.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { listAgentMetadata } from '../../utils/sessionStorage/paths.js'
import { PANEL_GRACE_MS } from '../../utils/task/framework.js'
import { notifyTasksUpdated } from '../../utils/tasks.js'
import { RESTART_CARRY_ROW_PREFIX } from '../../input-core/command-queue.js'
import { AGENT_STOP_BY_OPERATOR, agentStopReasonOf, enqueueAgentNotification, type LocalAgentTaskState } from './LocalAgentTask.js'

export const BACKGROUND_LAUNCH_LINE = 'Agent launched in the background.'

export const RECORDED_DESCRIPTION_MAX = 200
export const RECORDED_PROMPT_MAX = 20_000

export function recordedDescription(value: unknown): string {
  if (typeof value !== 'string') return ''
  const line = stripTerminalControls(value).replace(/\s+/g, ' ').trim()
  return line.length > RECORDED_DESCRIPTION_MAX ? `${sliceHeadAtGrapheme(line, RECORDED_DESCRIPTION_MAX - 1)}…` : line
}

export function recordedPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = stripTerminalControls(value)
  return text.length > RECORDED_PROMPT_MAX ? `${sliceHeadAtGrapheme(text, RECORDED_PROMPT_MAX - 1)}…` : text
}

export interface BackgroundLaunchReceipt {
  toolUseId: string
  agentId: string
  description: string
  prompt: string
  agentType: string
  launchedAt: number
}

export type RunnerRestartReason = 'crash' | 'stop' | 'settings' | 'relaunch'

export function coerceRestartReason(value: unknown): RunnerRestartReason | undefined {
  return value === 'crash' || value === 'stop' || value === 'settings' || value === 'relaunch' ? value : undefined
}

export function restartBecause(reason?: RunnerRestartReason): string {
  return reason === 'crash'
    ? ' after a crash'
    : reason === 'stop'
      ? ' after a stop'
      : reason === 'settings'
        ? ' after a settings change'
        : reason === 'relaunch'
          ? ' after a relaunch'
          : ''
}

export function restartStopSummary(description: string, reason?: RunnerRestartReason): string {
  const because = restartBecause(reason)
  return `Agent "${recordedDescription(description)}" was stopped — the session's runner restarted${because} before it finished, so nothing it started will be delivered; relaunch it if the result is still wanted`
}

export type BackgroundHandoverReason = 'turn-interrupted' | 'backgrounded' | 'agent-type' | 'sibling-ended'

export type SiblingEndFacts = { taskId: string; description: string; status: 'failed' | 'stopped'; error?: string }

export function foregroundNotKeptLine(reason: BackgroundHandoverReason, sibling?: SiblingEndFacts): string {
  switch (reason) {
    case 'turn-interrupted':
      return 'The foreground request was not kept: the turn it ran in was interrupted, so the agent was handed to the background to finish on its own.'
    case 'backgrounded':
      return 'The foreground request was not kept: the agent was moved to the background (ctrl+b, or it ran past the foreground threshold).'
    case 'agent-type':
      return 'The foreground request was not kept: this agent type always runs in the background.'
    case 'sibling-ended':
      return `The foreground request was not kept: a wait on a group returns the moment any member fails or stops — agent "${sibling?.description ?? 'a sibling'}"${sibling ? ` [${sibling.taskId}]` : ''} ${sibling?.status ?? 'ended'}${sibling?.error ? ` (${sibling.error})` : ''}; read its result now, and this agent runs on in the background (its own notice follows).`
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
          description: recordedDescription(input.description) || 'agent',
          prompt: recordedPrompt(input.prompt),
          agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'mercury-general',
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

export interface NamedLaunch {
  agentId: string
  name: string
  description: string
  launchedAt: number
}

export interface NamedLaunchReceipt extends NamedLaunch {
  toolUseId: string
}

const CONTINUATION_ID = /agentId: (\S+) \(internal/g

function lastContinuationId(text: string): string | undefined {
  let found: string | undefined
  for (const match of text.matchAll(CONTINUATION_ID)) found = match[1]
  return found
}

export function namedLaunchReceipts(messages: readonly Message[]): NamedLaunchReceipt[] {
  const launches = new Map<string, { name: string; description: string; launchedAt: number }>()
  const receipts: NamedLaunchReceipt[] = []
  for (const message of messages) {
    if (message.type === 'assistant') {
      const stamp = Date.parse(message.timestamp)
      for (const block of blocksOf(message.message.content)) {
        if (block.type !== 'tool_use' || block.name !== AGENT_TOOL_NAME || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as { name?: unknown; description?: unknown }
        if (typeof input.name !== 'string' || input.name.trim() === '') continue
        launches.set(block.id, {
          name: input.name.trim(),
          description: recordedDescription(input.description) || 'agent',
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
      const agentId = lastContinuationId(textOf(block.content))
      if (agentId === undefined) continue
      receipts.push({ toolUseId: block.tool_use_id, agentId, ...launch })
    }
  }
  return receipts
}

function carriedName<T extends NamedLaunch>(launches: readonly T[], name: string): T[] {
  const wanted = name.trim()
  const exact = launches.filter(launch => launch.name === wanted)
  if (exact.length > 0) return exact
  const folded = wanted.toLowerCase()
  return launches.filter(launch => launch.name.toLowerCase() === folded)
}

export function launchesNamed(messages: readonly Message[], name: string): NamedLaunchReceipt[] {
  return carriedName(namedLaunchReceipts(messages), name)
}

export async function recordedNamedLaunches(): Promise<NamedLaunch[]> {
  const launches: NamedLaunch[] = []
  for (const { agentId, metadata } of await listAgentMetadata()) {
    if (typeof metadata.name !== 'string' || metadata.name.trim() === '') continue
    launches.push({
      agentId,
      name: metadata.name.trim(),
      description: recordedDescription(metadata.description) || 'agent',
      launchedAt: typeof metadata.launchedAt === 'number' && Number.isFinite(metadata.launchedAt) ? metadata.launchedAt : 0,
    })
  }
  return launches.sort((a, b) => a.launchedAt - b.launchedAt)
}

export async function recordedLaunchesNamed(name: string): Promise<NamedLaunch[]> {
  return carriedName(await recordedNamedLaunches(), name)
}

export function settledLaunchIds(messages: readonly Message[]): Set<string> {
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const text = textOf(message.message.content)
    if (!text.includes(`<${TASK_NOTIFICATION_TAG}>`)) continue
    if (pickTag(text, STATUS_TAG) === 'resumed') continue
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
  reason?: RunnerRestartReason,
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
      summary: restartStopSummary(receipt.description, reason),
    })
  }
  return orphans
}

export const AGENT_RELAUNCH_NOTE =
  "The session's runner restarted while you were working, and you were relaunched from your transcript. Continue from where your transcript ends — the work before the restart stands on disk; do not redo it. Read your own diff (git diff) and read a file again before you edit it: the restart emptied the record of what you had read, so an edit without a fresh read is refused."

export type RestartCarryCounts = { relaunched: number; delivered: number; stopped: number }

export { RESTART_CARRY_ROW_PREFIX }

export function restartCarryRow(reason: RunnerRestartReason | undefined, counts: RestartCarryCounts): string {
  const because = reason === 'stop' ? 'after a stop' : 'after a crash'
  return `${RESTART_CARRY_ROW_PREFIX}${because}: ${counts.relaunched} background agents relaunched, ${counts.delivered} delivered from their receipts, ${counts.stopped} stopped`
}

export function isRestartCarryRow(text: string): boolean {
  return text.startsWith(RESTART_CARRY_ROW_PREFIX)
}

export type QueueLogRow = {
  operation: string
  content?: string
  uuid?: string
  mode?: string
  isMeta?: boolean
  sentAt?: string
  at?: string
  origin?: SaturnOrigin
}

type QueueOperationLine = {
  type?: unknown
  operation?: unknown
  content?: unknown
  commandUuid?: unknown
  mode?: unknown
  isMeta?: unknown
  sentAt?: unknown
  timestamp?: unknown
  origin?: unknown
  payload?: { kind?: unknown; metaKind?: unknown; fields?: Record<string, unknown> }
}

function queueLogRowOf(line: string): QueueLogRow | null {
  if (!line.includes('queue-operation')) return null
  let row: QueueOperationLine
  try {
    row = JSON.parse(line) as QueueOperationLine
  } catch {
    return null
  }
  const fields: Record<string, unknown> | undefined =
    row.payload?.kind === 'session-meta' && row.payload.metaKind === 'queue-operation'
      ? row.payload.fields
      : row.type === 'queue-operation'
        ? (row as Record<string, unknown>)
        : undefined
  if (fields === undefined || typeof fields.operation !== 'string') return null
  return {
    operation: fields.operation,
    ...(typeof fields.content === 'string' ? { content: fields.content } : {}),
    ...(typeof fields.commandUuid === 'string' ? { uuid: fields.commandUuid } : {}),
    ...(typeof fields.mode === 'string' ? { mode: fields.mode } : {}),
    ...(fields.isMeta === true ? { isMeta: true } : {}),
    ...(typeof fields.sentAt === 'string' ? { sentAt: fields.sentAt } : {}),
    ...(typeof fields.timestamp === 'string' ? { at: fields.timestamp } : {}),
    ...(isSaturnOrigin(fields.origin) ? { origin: fields.origin } : {}),
  }
}

export function queueLogRows(lines: Iterable<string>): QueueLogRow[] {
  const rows: QueueLogRow[] = []
  for (const line of lines) {
    const row = queueLogRowOf(line)
    if (row !== null) rows.push(row)
  }
  return rows
}

const TAKING_OPERATIONS: ReadonlySet<string> = new Set(['dequeue', 'remove', 'pop', 'popAll'])

export function pendingQueueLogRows(rows: readonly QueueLogRow[]): QueueLogRow[] {
  const pending: QueueLogRow[] = []
  for (const row of rows) {
    if (row.operation === 'enqueue') {
      pending.push(row)
      continue
    }
    if (row.operation === 'popAll') {
      pending.length = 0
      continue
    }
    if (TAKING_OPERATIONS.has(row.operation)) {
      if (row.uuid !== undefined) {
        const at = pending.findIndex(p => p.uuid === row.uuid)
        if (at >= 0) {
          pending.splice(at, 1)
          continue
        }
      }
      pending.shift()
    }
  }
  return pending
}

export function undeliveredLines(rows: readonly QueueLogRow[]): QueueLogRow[] {
  return pendingQueueLogRows(rows).filter(row => (row.mode === 'prompt' || row.mode === 'bash') && row.isMeta !== true && typeof row.content === 'string' && row.content.trim() !== '')
}

export type HeldAgentNotice = {
  taskId: string
  status: 'completed' | 'failed' | 'killed'
  value: string
  at?: string
  operatorStop: boolean
  landedWrites?: string
}

const HELD_NOTICE_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed'])

const NOTICE_BLOCK = new RegExp(`<${TASK_NOTIFICATION_TAG}>[\\s\\S]*?</${TASK_NOTIFICATION_TAG}>`, 'g')

export function heldAgentNotices(lines: Iterable<string>, agentIds: ReadonlySet<string>): Map<string, HeldAgentNotice> {
  const outcomes = new Map<string, HeldAgentNotice>()
  const stops = new Map<string, HeldAgentNotice>()
  const operatorStopWords = agentStopReasonOf(AGENT_STOP_BY_OPERATOR) ?? ''
  for (const row of queueLogRows(lines)) {
    if (row.operation !== 'enqueue' || typeof row.content !== 'string' || !row.content.includes(`<${TASK_NOTIFICATION_TAG}>`)) continue
    const value = row.content
    const taskId = pickTag(value, TASK_ID_TAG)
    const status = pickTag(value, STATUS_TAG)
    if (taskId === undefined || taskId === '' || !agentIds.has(taskId) || status === undefined || !HELD_NOTICE_STATUSES.has(status)) continue
    const summary = pickTag(value, SUMMARY_TAG) ?? ''
    const landed = summary.match(/(\d+ file writes? landed: [^—]+)/)
    const held: HeldAgentNotice = {
      taskId,
      status: status as HeldAgentNotice['status'],
      value,
      ...(row.sentAt !== undefined ? { at: row.sentAt } : row.at !== undefined ? { at: row.at } : {}),
      operatorStop: operatorStopWords !== '' && summary.includes(operatorStopWords),
      ...(landed !== null ? { landedWrites: landed[1]!.trim() } : {}),
    }
    if (held.status === 'killed') stops.set(taskId, held)
    else outcomes.set(taskId, held)
  }
  for (const [taskId, held] of stops) {
    if (!outcomes.has(taskId)) outcomes.set(taskId, held)
  }
  return outcomes
}

export function queuedNoticeIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    const attachment = message.attachment as unknown as { type?: unknown; prompt?: unknown }
    if (attachment.type !== 'queued_command') continue
    for (const notice of textOf(attachment.prompt).match(NOTICE_BLOCK) ?? []) {
      if (pickTag(notice, STATUS_TAG) === 'resumed') continue
      const toolUseId = pickTag(notice, TOOL_USE_ID_TAG)
      const taskId = pickTag(notice, TASK_ID_TAG)
      if (toolUseId) ids.add(toolUseId)
      if (taskId) ids.add(taskId)
    }
  }
  return ids
}

export function settledRecordFor(receipt: BackgroundLaunchReceipt, status: HeldAgentNotice['status'], now: number = Date.now()): LocalAgentTaskState {
  const { error: _unsaid, ...record } = stoppedRecordFor(receipt, now)
  void _unsaid
  return { ...record, status, notified: true }
}
