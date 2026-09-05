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
    attachment: { type: 'queued_command', prompt: value, commandMode: 'task-notification' },
    queued: true,
  } as unknown as Message
}

export function noticeRowLanded(row: Message, value: string): boolean {
  if (row.type !== 'attachment') return false
  const att = row.attachment as { type?: string; commandMode?: string; prompt?: unknown }
  if (att.type !== 'queued_command' || att.commandMode !== 'task-notification') return false
  const prompt = att.prompt
  const text =
    typeof prompt === 'string'
      ? prompt
      : Array.isArray(prompt)
        ? prompt.map(block => ((block as { type?: string; text?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : '')).join('\n')
        : ''
  return text === value
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
