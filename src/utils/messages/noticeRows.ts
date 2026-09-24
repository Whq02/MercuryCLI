import { TASK_NOTIFICATION_TAG } from '../../constants/xml.js'
import { stripTerminalControls } from '../stringUtils.js'

export type SaturnOrigin = {
  kind: 'saturn'
  fire: 'wake' | 'cron'
  firedAt: string
  scheduleId?: string
  spelling?: string
  reason?: string
  heldSince?: string
  heldWhy?: 'window' | 'parked'
}

export type NoticeBlock =
  | { kind: 'monitor'; taskId: string; name: string; lines: string[] }
  | { kind: 'notice'; lines: string[] }
  | { kind: 'saturn'; origin: SaturnOrigin; lines: string[] }

export const MONITOR_NOTICE_WORD = 'monitor'
export const PLAIN_NOTICE_WORD = 'notice'
export const SATURN_PLATE_NAME = 'Saturn'
export const SATURN_WAKE_WORD = 'self-paced wake'
export const SATURN_SCHEDULE_WORD = 'schedule'
export const ROW_SECOND_CLOCK_GAP_MS = 60_000
const WAKE_REASON_LINE = /^\[self-paced wake — why you woke: [^\n]*\]\n*/
const WAKE_SPELLING = /^in ~(\d+)s$/
const MINUTE_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const TENS_WORDS: Record<number, string> = { 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty' }

export function wakeDelaySpelling(delaySeconds: number): string {
  return `in ~${delaySeconds}s`
}

export function wakeDelayOfSpelling(spelling: string | undefined): number | null {
  const match = spelling === undefined ? null : WAKE_SPELLING.exec(spelling)
  return match === null ? null : Number(match[1])
}

export function cadenceWords(delaySeconds: number): string {
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) return ''
  if (delaySeconds % 60 !== 0) return `${delaySeconds}-second cadence`
  const minutes = delaySeconds / 60
  const word = MINUTE_WORDS[minutes] ?? TENS_WORDS[minutes] ?? String(minutes)
  return `${word}-minute cadence`
}

export function isSaturnOrigin(origin: unknown): origin is SaturnOrigin {
  if (typeof origin !== 'object' || origin === null) return false
  const o = origin as Record<string, unknown>
  return o.kind === 'saturn' && (o.fire === 'wake' || o.fire === 'cron') && typeof o.firedAt === 'string'
}

function clockOf(iso: string | undefined): string | null {
  if (iso === undefined) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function lowerFirst(words: string): string {
  return words.length > 1 && words[1] === words[1]!.toLowerCase() ? words[0]!.toLowerCase() + words.slice(1) : words
}

export function saturnFirstLine(origin: SaturnOrigin, rowStamp?: string): string {
  const parts: string[] = []
  if (origin.fire === 'wake') {
    parts.push(SATURN_WAKE_WORD)
    const delay = wakeDelayOfSpelling(origin.spelling)
    const cadence = delay === null ? '' : cadenceWords(delay)
    if (cadence !== '') parts.push(cadence)
    else if (origin.spelling !== undefined && origin.spelling !== '') parts.push(lowerFirst(origin.spelling))
    if (origin.reason !== undefined && origin.reason.trim() !== '') parts.push(`reason: ${origin.reason.replace(/[\r\n]+/g, ' ').trim()}`)
  } else {
    parts.push(origin.scheduleId !== undefined && origin.scheduleId !== '' ? `${SATURN_SCHEDULE_WORD} ${origin.scheduleId}` : SATURN_SCHEDULE_WORD)
    if (origin.spelling !== undefined && origin.spelling !== '') parts.push(lowerFirst(origin.spelling))
  }
  const held = clockOf(origin.heldSince)
  if (held !== null) {
    const why = origin.heldWhy === 'window' ? ' · the usage window was closed' : origin.heldWhy === 'parked' ? ' · the session was parked' : ''
    parts.push(`held since ${held}${why}`)
    return parts.join(' · ')
  }
  const fired = clockOf(origin.firedAt)
  const gap = Date.parse(rowStamp ?? '') - Date.parse(origin.firedAt)
  if (fired !== null && Number.isFinite(gap) && gap >= ROW_SECOND_CLOCK_GAP_MS) parts.push(`fired ${fired}`)
  return parts.join(' · ')
}

export function saturnPromptLines(text: string): string[] {
  return noticeLines(text.replace(WAKE_REASON_LINE, ''))
}

export function saturnBlockOf(origin: SaturnOrigin, text: string): NoticeBlock {
  return { kind: 'saturn', origin, lines: saturnPromptLines(text) }
}

const MONITOR_OPEN = /^<monitor task=("(?:[^"\\]|\\.)*") name=("(?:[^"\\]|\\.)*")>/
const MONITOR_CLOSE = '</monitor>'
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

function unquote(json: string): string {
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'string' ? value : json
  } catch {
    return json
  }
}

export function noticeLines(text: string): string[] {
  return stripTerminalControls(text)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
}

function foldSameWatch(blocks: NoticeBlock[]): NoticeBlock[] {
  const out: NoticeBlock[] = []
  for (const block of blocks) {
    const last = out[out.length - 1]
    if (block.kind === 'monitor' && last !== undefined && last.kind === 'monitor' && last.taskId === block.taskId && last.name === block.name) {
      out[out.length - 1] = { ...last, lines: [...last.lines, ...block.lines] }
      continue
    }
    out.push(block)
  }
  return out
}

export function wrappedNoticeBlocks(text: string): NoticeBlock[] | null {
  const blocks: NoticeBlock[] = []
  let rest = text.replace(/^\s+/, '')
  while (rest !== '') {
    const monitor = MONITOR_OPEN.exec(rest)
    if (monitor !== null) {
      const closeAt = rest.indexOf(MONITOR_CLOSE, monitor[0].length)
      if (closeAt === -1) return null
      blocks.push({ kind: 'monitor', taskId: unquote(monitor[1]!), name: unquote(monitor[2]!), lines: noticeLines(rest.slice(monitor[0].length, closeAt)) })
      rest = rest.slice(closeAt + MONITOR_CLOSE.length).replace(/^\s+/, '')
      continue
    }
    if (rest.startsWith(REMINDER_OPEN)) {
      const closeAt = rest.indexOf(REMINDER_CLOSE, REMINDER_OPEN.length)
      if (closeAt === -1) return null
      blocks.push({ kind: 'notice', lines: noticeLines(rest.slice(REMINDER_OPEN.length, closeAt)) })
      rest = rest.slice(closeAt + REMINDER_CLOSE.length).replace(/^\s+/, '')
      continue
    }
    return null
  }
  return blocks.length === 0 ? null : foldSameWatch(blocks)
}

export function noticeOfText(text: string, fromNotificationLane: boolean): NoticeBlock[] | null {
  if (text.includes(`<${TASK_NOTIFICATION_TAG}`)) return null
  const wrapped = wrappedNoticeBlocks(text)
  if (wrapped !== null) return wrapped
  if (!fromNotificationLane) return null
  const lines = noticeLines(text)
  return lines.length === 0 ? null : [{ kind: 'notice', lines }]
}

export function isNotificationLaneRow(row: { type?: string; attachment?: { type?: string; commandMode?: string } }): boolean {
  return row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.commandMode === 'task-notification'
}

export function noticePlate(block: NoticeBlock, rowStamp?: string): string {
  if (block.kind === 'notice') return PLAIN_NOTICE_WORD
  if (block.kind === 'saturn') return `[${SATURN_PLATE_NAME}] · ${saturnFirstLine(block.origin, rowStamp)}`
  return block.name === '' ? MONITOR_NOTICE_WORD : `${MONITOR_NOTICE_WORD} · ${block.name}`
}
