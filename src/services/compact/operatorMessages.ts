import { TERMINAL_OUTPUT_TAGS } from '../../constants/xml.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { sliceHeadAtGrapheme } from '../../utils/intl.js'
import { isOperatorTurn } from '../../utils/messages/operatorTurns.js'

export const OPERATOR_MESSAGES_ATTACHMENT_TYPE = 'compact_operator_messages' as const

export const OPERATOR_MESSAGES_TOKEN_BUDGET = 20_000

export const OPERATOR_MESSAGE_TRUNCATION_MARKER = '[the rest of this message is cut for the budget; the summary covers it]'

const MIN_TRUNCATED_CHARS = 80
const CHARS_PER_TOKEN = 4

export type OperatorMessageEntry = { ordinal: number; text: string; truncated?: boolean }

export type OperatorMessagesAttachment = Extract<Attachment, { type: typeof OPERATOR_MESSAGES_ATTACHMENT_TYPE }>

const TERMINAL_OUTPUT_PREFIXES = TERMINAL_OUTPUT_TAGS.map(tag => `<${tag}>`)

function textOfContent(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'document') parts.push('[document]')
  }
  return parts.join('\n')
}

function isHumanOrigin(origin: { kind: string } | undefined): boolean {
  return origin === undefined || origin.kind === 'human'
}

function isTerminalOutputText(text: string): boolean {
  const head = text.trimStart()
  return TERMINAL_OUTPUT_PREFIXES.some(prefix => head.startsWith(prefix))
}

export function operatorTextOf(message: Message): string | null {
  if (message.type !== 'user') return null
  const user = message as UserMessage
  if (user.isVirtual === true) return null
  if (!isHumanOrigin(user.origin)) return null
  if (!isOperatorTurn(user)) return null
  const text = textOfContent(user.message.content)
  if (text.trim() === '' || isTerminalOutputText(text)) return null
  return text
}

export function steerTextOf(attachment: Attachment): string | null {
  if (attachment.type !== 'queued_command') return null
  if (attachment.isMeta === true) return null
  if (!isHumanOrigin(attachment.origin)) return null
  if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') return null
  const text = textOfContent(attachment.prompt)
  return text.trim() === '' ? null : text
}

export function estimateOperatorMessageTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function collectOperatorTexts(messages: Message[], keptUuids?: ReadonlySet<string>): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (keptUuids?.has(message.uuid)) continue
    if (message.type === 'attachment') {
      const attachment = message.attachment
      if (attachment.type === OPERATOR_MESSAGES_ATTACHMENT_TYPE) {
        for (let index = attachment.messages.length - 1; index >= 0; index--) texts.push(attachment.messages[index]!.text)
        continue
      }
      const steer = steerTextOf(attachment)
      if (steer === null) continue
      if (attachment.type === 'queued_command' && attachment.source_uuid !== undefined) {
        if (seen.has(attachment.source_uuid)) continue
        seen.add(attachment.source_uuid)
      }
      texts.push(steer)
      continue
    }
    if (message.type !== 'user' || seen.has(message.uuid)) continue
    const text = operatorTextOf(message)
    if (text === null) continue
    seen.add(message.uuid)
    texts.push(text)
  }
  return texts
}

export function selectOperatorMessages(
  messages: Message[],
  opts?: { keptUuids?: ReadonlySet<string>; tokenBudget?: number },
): OperatorMessagesAttachment | null {
  const budget = Math.max(0, opts?.tokenBudget ?? OPERATOR_MESSAGES_TOKEN_BUDGET)
  const texts = collectOperatorTexts(messages, opts?.keptUuids)
  if (texts.length === 0) return null
  const selected: OperatorMessageEntry[] = []
  let remaining = budget
  for (let ordinal = texts.length; ordinal >= 1; ordinal--) {
    const text = texts[ordinal - 1]!
    const tokens = estimateOperatorMessageTokens(text)
    if (tokens <= remaining) {
      selected.push({ ordinal, text })
      remaining -= tokens
      continue
    }
    const keepChars = remaining * CHARS_PER_TOKEN - OPERATOR_MESSAGE_TRUNCATION_MARKER.length - 1
    if (keepChars >= MIN_TRUNCATED_CHARS) {
      selected.push({ ordinal, text: `${sliceHeadAtGrapheme(text, keepChars)}\n${OPERATOR_MESSAGE_TRUNCATION_MARKER}`, truncated: true })
    }
    break
  }
  if (selected.length === 0) return null
  return { type: OPERATOR_MESSAGES_ATTACHMENT_TYPE, messages: selected, omitted: texts.length - selected.length }
}

export function operatorMessagesBlockText(attachment: OperatorMessagesAttachment): string {
  const shown = attachment.messages.length
  const total = shown + attachment.omitted
  const coverage =
    attachment.omitted === 0
      ? `all ${total} of them`
      : `the newest ${shown} of ${total}; ${attachment.omitted === 1 ? 'message 1 is' : `messages 1-${attachment.omitted} are`} left to the summary`
  const head = `The operator's own messages from the stretch folded into the summary below, verbatim and newest first (${coverage}). They are the record of what was asked, in the operator's exact words; the summary says what was done about each and where the work stands.`
  const rows = attachment.messages.map(entry => `<operator-message ordinal="${entry.ordinal}" of="${total}">\n${entry.text}\n</operator-message>`)
  return [head, ...rows].join('\n\n')
}
