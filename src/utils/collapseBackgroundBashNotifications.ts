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
