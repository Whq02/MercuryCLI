import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../tasks/LocalShellTask/LocalShellTask.js'
import type {
  AttachmentMessage,
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import { extractTag } from './messages.js'

export const FOLDED_COUNT_TAG = 'folded'

export type ShellOutcome = 'completed' | 'failed' | 'killed'

export interface ShellNotice {
  message: RenderableMessage
  shape: 'attachment' | 'user'
  status: ShellOutcome
  detail: string
  queued: boolean
}

function noticeText(msg: RenderableMessage): { text: string; shape: 'attachment' | 'user' } | null {
  if (msg.type === 'user') {
    const head = msg.message.content[0]
    if (head?.type !== 'text') return null
    return { text: head.text, shape: 'user' }
  }
  if (msg.type === 'attachment') {
    const att = msg.attachment as { type?: string; commandMode?: string; prompt?: unknown }
    if (att.type !== 'queued_command' || att.commandMode !== 'task-notification') return null
    const prompt = att.prompt
    const text =
      typeof prompt === 'string'
        ? prompt
        : Array.isArray(prompt)
          ? prompt
              .map(block => ((block as { type?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
              .join('\n')
          : ''
    return { text, shape: 'attachment' }
  }
  return null
}

export function shellNoticeOf(msg: RenderableMessage): ShellNotice | null {
  const found = noticeText(msg)
  if (found === null || !found.text.includes(`<${TASK_NOTIFICATION_TAG}`)) return null
  const status = extractTag(found.text, STATUS_TAG)
  if (status !== 'completed' && status !== 'failed' && status !== 'killed') return null
  const summary = extractTag(found.text, SUMMARY_TAG) ?? ''
  if (!summary.startsWith(BACKGROUND_BASH_SUMMARY_PREFIX)) return null
  return {
    message: msg,
    shape: found.shape,
    status,
    detail: summary.slice(BACKGROUND_BASH_SUMMARY_PREFIX.length).trim(),
    queued: (msg as { queued?: true }).queued === true,
  }
}

function titleOf(detail: string): string {
  const m = /^("[^"]*") (?:completed|failed|was stopped)(.*)$/.exec(detail)
  return m ? `${m[1]}${m[2] ?? ''}` : detail
}

export function foldedSummary(run: readonly ShellNotice[]): string {
  const done = run.filter(n => n.status === 'completed').length
  const failed = run.filter(n => n.status === 'failed')
  const stopped = run.filter(n => n.status === 'killed')
  const queued = run[0]?.queued === true
  if (!queued && failed.length === 0 && stopped.length === 0) return `${run.length} background commands completed`
  const parts = [queued ? `${run.length} queued for the next turn` : `${run.length} background commands`]
  if (done > 0) parts.push(`${done} done`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)
  if (stopped.length > 0) parts.push(`${stopped.length} stopped`)
  const named = [...failed, ...stopped].map(n => titleOf(n.detail))
  return parts.join(' · ') + (named.length > 0 ? ` — ${named.join(', ')}` : '')
}

function foldedRow(run: readonly ShellNotice[]): RenderableMessage {
  const first = run[0]!
  const status: ShellOutcome = run.some(n => n.status === 'failed')
    ? 'failed'
    : run.some(n => n.status === 'killed')
      ? 'killed'
      : 'completed'
  const body =
    `<${TASK_NOTIFICATION_TAG}><${STATUS_TAG}>${status}</${STATUS_TAG}>` +
    `<${SUMMARY_TAG}>${foldedSummary(run)}</${SUMMARY_TAG}>` +
    `<${FOLDED_COUNT_TAG}>${run.length}</${FOLDED_COUNT_TAG}>` +
    `</${TASK_NOTIFICATION_TAG}>`
  if (first.shape === 'attachment') {
    const template = first.message as AttachmentMessage
    return { ...template, attachment: { ...template.attachment, prompt: body } } as RenderableMessage
  }
  const template = first.message as NormalizedUserMessage
  return {
    ...template,
    message: {
      role: 'user',
      content: [{ type: 'text', text: body }],
    },
  }
}

export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  if (!isFullscreenEnvEnabled() || verbose) return messages

  const out: RenderableMessage[] = []
  for (let i = 0; i < messages.length; ) {
    const first = shellNoticeOf(messages[i]!)
    if (first === null) {
      out.push(messages[i]!)
      i += 1
      continue
    }
    const run = [first]
    let end = i + 1
    for (; end < messages.length; end++) {
      const next = shellNoticeOf(messages[end]!)
      if (next === null || next.queued !== first.queued) break
      run.push(next)
    }
    out.push(run.length === 1 ? first.message : foldedRow(run))
    i = end
  }
  return out
}
