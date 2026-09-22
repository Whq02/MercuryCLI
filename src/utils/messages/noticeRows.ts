import { TASK_NOTIFICATION_TAG } from '../../constants/xml.js'
import { stripTerminalControls } from '../stringUtils.js'

export type NoticeBlock =
  | { kind: 'monitor'; taskId: string; name: string; lines: string[] }
  | { kind: 'notice'; lines: string[] }

export const MONITOR_NOTICE_WORD = 'monitor'
export const PLAIN_NOTICE_WORD = 'notice'

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

export function noticePlate(block: NoticeBlock): string {
  if (block.kind === 'notice') return PLAIN_NOTICE_WORD
  return block.name === '' ? MONITOR_NOTICE_WORD : `${MONITOR_NOTICE_WORD} · ${block.name}`
}
