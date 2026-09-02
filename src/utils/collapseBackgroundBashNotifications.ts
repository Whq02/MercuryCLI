import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../tasks/LocalShellTask/LocalShellTask.js'
import type {
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import { extractTag } from './messages.js'

/**
 * A task-notification for a background shell command that finished cleanly.
 * The predicate is deliberately narrow — anything it rejects keeps its own
 * transcript row: failures and kills stay individually visible, agent and
 * workflow notifications carry a different summary prefix, and monitor-kind
 * summaries word their completions differently (monitor stream events have
 * no status tag at all, so they can never qualify).
 */
function isCollapsibleShellCompletion(
  msg: RenderableMessage,
): msg is NormalizedUserMessage {
  if (msg.type !== 'user') return false
  const head = msg.message.content[0]
  if (head?.type !== 'text') return false
  if (!head.text.includes(`<${TASK_NOTIFICATION_TAG}`)) return false
  if (extractTag(head.text, STATUS_TAG) !== 'completed') return false
  return (
    extractTag(head.text, SUMMARY_TAG)?.startsWith(
      BACKGROUND_BASH_SUMMARY_PREFIX,
    ) === true
  )
}

/**
 * One replacement row for a whole run, shaped as a task-notification so the
 * existing notification renderer draws it — no dedicated renderer exists for
 * the collapsed form. The first message of the run donates every field
 * except the message body.
 */
function syntheticRunNotification(
  template: NormalizedUserMessage,
  runLength: number,
): RenderableMessage {
  const body =
    `<${TASK_NOTIFICATION_TAG}><${STATUS_TAG}>completed</${STATUS_TAG}>` +
    `<${SUMMARY_TAG}>${runLength} background commands completed</${SUMMARY_TAG}>` +
    `</${TASK_NOTIFICATION_TAG}>`
  return {
    ...template,
    message: {
      role: 'user',
      content: [{ type: 'text', text: body }],
    },
  }
}

/**
 * Transcript de-noiser: each run of consecutive clean background-bash
 * completion notifications renders as a single synthetic "N background
 * commands completed" row. A run of one passes through unchanged, as does
 * everything the predicate above rejects.
 *
 * Inert outside fullscreen, and inert in verbose mode — the transcript
 * overlay is where the operator asked to see every completion one by one.
 */
export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  if (!isFullscreenEnvEnabled() || verbose) return messages

  const out: RenderableMessage[] = []
  for (let i = 0; i < messages.length; ) {
    const first = messages[i]!
    if (!isCollapsibleShellCompletion(first)) {
      out.push(first)
      i += 1
      continue
    }
    let end = i + 1
    while (end < messages.length && isCollapsibleShellCompletion(messages[end]!)) {
      end += 1
    }
    const runLength = end - i
    out.push(runLength === 1 ? first : syntheticRunNotification(first, runLength))
    i = end
  }
  return out
}
