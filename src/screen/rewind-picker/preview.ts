import {
  BASH_INPUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_NAME_TAG,
} from '../../engine/message-shapes/messageTags.js'
import type { UserMessage } from '../../engine/message-shapes/message.js'
import { stripDisplayTagsAllowEmpty } from '../messages/displayTags.js'

export function messageText(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  let last = ''
  for (const block of content) {
    if (block.type === 'text') last = block.text
  }
  return last
}

const PREVIEW_CHAR_CAP = 500
const PREVIEW_LINE_CAP = 4

export function previewOf(
  message: UserMessage,
  width?: number,
): { text: string; shell: boolean; command: boolean } {
  const raw = messageText(message).trim()
  if (raw === '') return { text: '(empty message)', shell: false, command: false }
  const bashMatch = raw.match(
    new RegExp(`<${BASH_INPUT_TAG}>([\\s\\S]*?)</${BASH_INPUT_TAG}>`),
  )
  if (bashMatch) {
    return { text: `! ${bashMatch[1]!.trim()}`, shell: true, command: false }
  }
  const nameMatch = raw.match(
    new RegExp(`<${COMMAND_NAME_TAG}>([\\s\\S]*?)</${COMMAND_NAME_TAG}>`),
  )
  if (nameMatch) {
    const argsMatch = raw.match(
      new RegExp(`<${COMMAND_ARGS_TAG}>([\\s\\S]*?)</${COMMAND_ARGS_TAG}>`),
    )
    const name = nameMatch[1]!.trim()
    const args = argsMatch?.[1]?.trim() ?? ''
    const skillMatch = name.match(/^skill:(.+)$/)
    if (skillMatch) {
      return {
        text: `/${skillMatch[1]}${args ? ` ${args}` : ''}`,
        shell: false,
        command: true,
      }
    }
    return { text: `${name}${args ? ` ${args}` : ''}`, shell: false, command: true }
  }
  let text = stripDisplayTagsAllowEmpty(raw)
  if (text === '') return { text: '(no prompt text)', shell: false, command: false }
  if (width !== undefined) {
    text = text.split('\n')[0]!.slice(0, Math.max(8, width))
  } else {
    const lines = text.split('\n').slice(0, PREVIEW_LINE_CAP)
    text = lines.join('\n').slice(0, PREVIEW_CHAR_CAP)
  }
  return { text, shell: false, command: false }
}
