import type { NoticeKind, NoticeRowV1, NoticeState } from '../engine-connector/types.js'
import { createSignal } from '../../utils/signal.js'
import { isAgentMessageNotice } from '../../constants/agentMessage.js'


export const MAIN_THREAD_AGENT = 'main'

export interface NoticeRecord extends NoticeRowV1 {
  key: string
  altKey?: string
}

const MAX_WORDS = 120
const SETTLED_KEEP = 48
const FACTS_ROWS = 64

let seq = 0
let records: NoticeRecord[] = []
let clock: () => number = () => Date.now()
const changed = createSignal()

export function setNoticeLedgerClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now())
}

export const subscribeNoticeLedger = changed.subscribe

const isOpen = (state: NoticeState): boolean => state === 'unread' || state === 'nudged'

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= MAX_WORDS ? line : `${line.slice(0, MAX_WORDS - 1)}…`
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return ''
}

export function noticeWordsOf(value: unknown): string {
  const text = textOf(value)
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)
  if (summary !== null && summary[1]!.trim() !== '') return clip(summary[1]!)
  const monitor = /<monitor\b[^>]*\bname=("(?:[^"\\]|\\.)*")/.exec(text)
  if (monitor !== null) {
    try {
      return clip(`monitor ${JSON.stringify(JSON.parse(monitor[1]!))} reported`)
    } catch {
      return clip(`monitor ${monitor[1]!} reported`)
    }
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('<')) continue
    return clip(trimmed)
  }
  return clip(text) || 'a notice'
}

type QueuedLike = {
  mode?: string
  value?: unknown
  agentId?: string
  workload?: string
  queueId?: string
  uuid?: unknown
}

export function noticeOfQueued(command: QueuedLike): { agentId: string; kind: NoticeKind; words: string } | null {
  if (command.mode === 'task-notification') {
    const kind: NoticeKind = isAgentMessageNotice(textOf(command.value)) ? 'message' : 'completion'
    return { agentId: command.agentId ?? MAIN_THREAD_AGENT, kind, words: noticeWordsOf(command.value) }
  }
  if (command.mode === 'prompt' && command.workload === 'cron') {
    return { agentId: command.agentId ?? MAIN_THREAD_AGENT, kind: 'wake', words: `scheduled wake: ${noticeWordsOf(command.value)}` }
  }
  return null
}

function settle(): void {
  const settled = records.filter(r => !isOpen(r.state))
  if (settled.length > SETTLED_KEEP) {
    const drop = new Set(settled.slice(0, settled.length - SETTLED_KEEP).map(r => r.id))
    records = records.filter(r => !drop.has(r.id))
  }
  changed.emit()
}

export function recordNotice(input: { agentId: string; kind: NoticeKind; words: string; key?: string; altKey?: string }): NoticeRecord {
  if (input.key !== undefined) {
    const existing = records.find(r => isOpen(r.state) && r.key === input.key)
    if (existing !== undefined) return existing
  }
  seq += 1
  const record: NoticeRecord = {
    id: `n${seq}`,
    agentId: input.agentId,
    kind: input.kind,
    words: clip(input.words),
    key: input.key ?? `n${seq}`,
    ...(input.altKey !== undefined ? { altKey: input.altKey } : {}),
    deliveredAtMs: clock(),
    state: 'unread',
  }
  records.push(record)
  changed.emit()
  return record
}

export function recordQueuedNotice(command: QueuedLike): NoticeRecord | null {
  const notice = noticeOfQueued(command)
  if (notice === null) return null
  return recordNotice({
    ...notice,
    ...(command.queueId !== undefined ? { key: command.queueId } : {}),
    ...(command.uuid !== undefined ? { altKey: String(command.uuid) } : {}),
  })
}

export function queuedNoticeKeys(commands: readonly QueuedLike[]): string[] {
  const keys: string[] = []
  for (const command of commands) {
    if (command.queueId !== undefined) keys.push(command.queueId)
    if (command.uuid !== undefined) keys.push(String(command.uuid))
  }
  return keys
}

export function recordAgentMessage(agentId: string, message: string): NoticeRecord {
  return recordNotice({ agentId, kind: 'message', words: noticeWordsOf(message) })
}

function matches(record: NoticeRecord, keys: ReadonlySet<string>): boolean {
  return keys.has(record.key) || (record.altKey !== undefined && keys.has(record.altKey))
}

export function consumeNotices(keys: readonly string[]): number {
  if (keys.length === 0) return 0
  const wanted = new Set(keys)
  const now = clock()
  let n = 0
  for (const record of records) {
    if (!isOpen(record.state) || !matches(record, wanted)) continue
    record.state = 'consumed'
    record.consumedAtMs = now
    n += 1
  }
  if (n > 0) settle()
  return n
}

export function retireNotices(keys: readonly string[], why: string): number {
  if (keys.length === 0) return 0
  const wanted = new Set(keys)
  const now = clock()
  let n = 0
  for (const record of records) {
    if (!isOpen(record.state) || !matches(record, wanted)) continue
    record.state = 'retired'
    record.retiredAtMs = now
    record.retiredWhy = why
    n += 1
  }
  if (n > 0) settle()
  return n
}

export function consumeAgentMessages(agentId: string): number {
  const now = clock()
  let n = 0
  for (const record of records) {
    if (!isOpen(record.state) || record.kind !== 'message' || record.agentId !== agentId) continue
    record.state = 'consumed'
    record.consumedAtMs = now
    n += 1
  }
  if (n > 0) settle()
  return n
}

export function retireNotice(id: string, why: string): boolean {
  const record = records.find(r => r.id === id)
  if (record === undefined || !isOpen(record.state)) return false
  record.state = 'retired'
  record.retiredAtMs = clock()
  record.retiredWhy = why
  settle()
  return true
}

export function markNudged(ids: readonly string[]): number {
  const wanted = new Set(ids)
  const now = clock()
  let n = 0
  for (const record of records) {
    if (!wanted.has(record.id) || record.nudgedAtMs !== undefined) continue
    record.nudgedAtMs = now
    if (record.state === 'unread') record.state = 'nudged'
    n += 1
  }
  if (n > 0) changed.emit()
  return n
}

export function openNotices(): NoticeRecord[] {
  return records.filter(r => isOpen(r.state))
}

export function unreadNoticeCount(agentId: string): number {
  let n = 0
  for (const record of records) if (isOpen(record.state) && record.agentId === agentId) n += 1
  return n
}

export function unreadNoticeCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (!isOpen(record.state)) continue
    counts.set(record.agentId, (counts.get(record.agentId) ?? 0) + 1)
  }
  return counts
}

function rowOf(record: NoticeRecord): NoticeRowV1 {
  return {
    id: record.id,
    agentId: record.agentId,
    kind: record.kind,
    words: record.words,
    deliveredAtMs: record.deliveredAtMs,
    state: record.state,
    ...(record.consumedAtMs !== undefined ? { consumedAtMs: record.consumedAtMs } : {}),
    ...(record.nudgedAtMs !== undefined ? { nudgedAtMs: record.nudgedAtMs } : {}),
    ...(record.retiredAtMs !== undefined ? { retiredAtMs: record.retiredAtMs } : {}),
    ...(record.retiredWhy !== undefined ? { retiredWhy: record.retiredWhy } : {}),
  }
}

export function noticeRows(): NoticeRowV1[] {
  const open = records.filter(r => isOpen(r.state))
  const settled = records.filter(r => !isOpen(r.state)).reverse()
  return [...open, ...settled].slice(0, FACTS_ROWS).map(rowOf)
}

export function resetNoticeLedger(): void {
  records = []
  seq = 0
  clock = () => Date.now()
}
