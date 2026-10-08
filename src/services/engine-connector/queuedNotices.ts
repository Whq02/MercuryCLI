import { createHash, randomUUID } from 'node:crypto'
import type { Message } from '../../types/message.js'
import type { QueuedFactV1 } from './seatProjections.js'

const NOTICE_KEY_PREFIX = 'notice:'

export function isNoticeFact(entry: Pick<QueuedFactV1, 'mode'>): boolean {
  return entry.mode === 'task-notification'
}

export function noticeKeyOf(value: string): string {
  return `${NOTICE_KEY_PREFIX}${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

export function isNoticeKey(key: string): boolean {
  return key.startsWith(NOTICE_KEY_PREFIX)
}

export function createNoticeRow(value: string, atMs: number): Message {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date(atMs).toISOString(),
    attachment: { type: 'queued_command', prompt: value, commandMode: 'task-notification', sentAt: new Date(atMs).toISOString() },
    queued: true,
  } as unknown as Message
}

const TASK_ID_FRAME = /<task-id>([\s\S]*?)<\/task-id>/

export function noticeTaskId(value: string): string | undefined {
  const id = TASK_ID_FRAME.exec(value)?.[1]?.trim()
  return id === undefined || id === '' ? undefined : id
}

const LANDING_GRACE_MS = 1000

function textOfContent(content: unknown, joiner: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => ((block as { type?: string; text?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : '')).join(joiner)
}

export function deliveredNoticeRow(row: Message, atMs: number): Message {
  const deliveredAt = new Date(atMs).toISOString()
  const next = { ...row, timestamp: deliveredAt } as Message & { queued?: true; heldFor?: 'compaction' }
  delete next.queued
  delete next.heldFor
  if (next.type === 'attachment') next.attachment = { ...next.attachment, deliveredAt } as typeof next.attachment
  return next
}

export function placeDeliveredNotices(rows: readonly Message[], committed?: ReadonlyMap<string, unknown>): readonly Message[] {
  const out: Message[] = []
  const waiting: Message[] = []
  const landing: Message[] = []
  let changed = false
  for (const row of rows) {
    if ((row as { queued?: true }).queued === true) {
      waiting.push(row)
      continue
    }
    if (row.type === 'attachment' && row.attachment.type === 'queued_command' && row.attachment.commandMode === 'task-notification') {
      const stamp = row.attachment.deliveredAt ?? row.timestamp
      if (Number.isFinite(Date.parse(stamp))) {
        const projected = stamp === row.timestamp ? row : { ...row, timestamp: stamp }
        if (committed?.has(row.uuid)) {
          landing.push(projected)
          changed = true
        } else {
          out.push(projected)
          changed ||= waiting.length > 0 || stamp !== row.timestamp
        }
        continue
      }
    }
    for (const queued of waiting) out.push(queued)
    waiting.length = 0
    out.push(row)
  }
  for (const queued of waiting) out.push(queued)
  if (landing.length === 0) return changed ? out : rows
  const placed: Message[] = []
  let next = 0
  for (const row of out) {
    const at = Date.parse(deliveryClockOf(row) ?? '')
    while (next < landing.length && ((row as { queued?: true }).queued === true || Date.parse(landing[next]!.timestamp) < at)) placed.push(landing[next++]!)
    placed.push(row)
  }
  while (next < landing.length) placed.push(landing[next++]!)
  return placed
}

function deliveryClockOf(row: Message): string | undefined {
  const delivered = row.type === 'attachment' ? (row.attachment as { deliveredAt?: string }).deliveredAt : undefined
  return delivered ?? (row as { timestamp?: string }).timestamp
}

export function noticeRowLanded(row: Message, value: string, notBeforeMs?: number): boolean {
  if (notBeforeMs !== undefined) {
    const at = Date.parse(deliveryClockOf(row) ?? '')
    if (!Number.isNaN(at) && at + LANDING_GRACE_MS < notBeforeMs) return false
  }
  if (row.type === 'attachment') {
    const att = row.attachment as { type?: string; commandMode?: string; prompt?: unknown }
    if (att.type !== 'queued_command' || att.commandMode !== 'task-notification') return false
    return textOfContent(att.prompt, '\n') === value
  }
  if (row.type !== 'user' || (row as { isMeta?: boolean }).isMeta === true) return false
  const text = textOfContent((row as { message?: { content?: unknown } }).message?.content, '')
  if (text === '') return false
  const id = noticeTaskId(value)
  if (id === undefined) return text === value
  return text.includes(`<task-id>${id}</task-id>`) && text.includes(value)
}

export function queueOrderedSends<T extends { clientMessageId: string }>(sends: readonly T[], queue: readonly QueuedFactV1[]): T[] {
  const position = new Map<string, number>()
  queue.forEach((entry, i) => {
    if (typeof entry.uuid === 'string' && !position.has(entry.uuid)) position.set(entry.uuid, i)
    if (isNoticeFact(entry)) {
      const key = noticeKeyOf(entry.value)
      if (!position.has(key)) position.set(key, i)
    }
  })
  const held = sends.map((s, i) => ({ s, i, pos: position.get(s.clientMessageId) }))
  const slots = held.filter((h): h is { s: T; i: number; pos: number } => h.pos !== undefined)
  if (slots.length < 2) return [...sends]
  const ordered = [...slots].sort((a, b) => a.pos - b.pos || a.i - b.i)
  const out = [...sends]
  slots.forEach((slot, k) => {
    out[slot.i] = ordered[k]!.s
  })
  return out
}
