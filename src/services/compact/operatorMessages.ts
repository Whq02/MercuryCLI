import { TERMINAL_OUTPUT_TAGS } from '../../constants/xml.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { isCommandEcho, isOperatorTurn } from '../../utils/messages/operatorTurns.js'

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

export function priorOperatorMessages(messages: readonly Message[]): number {
  let prior = 0
  for (const message of messages) {
    if (message.type !== 'attachment' || message.attachment.type !== OPERATOR_MESSAGES_ATTACHMENT_TYPE) continue
    prior = Math.max(prior, message.attachment.messages.length + message.attachment.omitted)
  }
  return prior
}

export function earlierOperatorEntries(messages: readonly Message[]): OperatorMessageEntry[] {
  let latest: OperatorMessagesAttachment | null = null
  for (const message of messages) {
    if (message.type !== 'attachment' || message.attachment.type !== OPERATOR_MESSAGES_ATTACHMENT_TYPE) continue
    latest = message.attachment
  }
  if (latest === null) return []
  return [...latest.messages]
    .filter(entry => entry.truncated !== true && entry.text.trim() !== '' && !isCommandEcho(entry.text) && !isTerminalOutputText(entry.text))
    .sort((a, b) => a.ordinal - b.ordinal)
}

export function collectOperatorTexts(messages: Message[], keptUuids?: ReadonlySet<string>): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (keptUuids?.has(message.uuid)) continue
    if (message.type === 'attachment') {
      const attachment = message.attachment
      if (attachment.type === OPERATOR_MESSAGES_ATTACHMENT_TYPE) continue
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
  const budget = Math.max(0, opts?.tokenBudget ?? Infinity)
  const prior = priorOperatorMessages(messages)
  const texts = collectOperatorTexts(messages, opts?.keptUuids)
  const earlier = earlierOperatorEntries(messages)
  if (texts.length === 0 && earlier.length === 0) return null
  const selected: OperatorMessageEntry[] = []
  let remaining = budget
  for (let index = texts.length; index >= 1; index--) {
    const text = texts[index - 1]!
    const tokens = estimateOperatorMessageTokens(text)
    if (tokens <= remaining) {
      selected.push({ ordinal: prior + index, text })
      remaining -= tokens
      continue
    }
    throw new Error('The operator messages do not fit verbatim; the original context is kept.')
  }
  let room = Math.min(remaining, OPERATOR_MESSAGES_TOKEN_BUDGET - selected.reduce((n, entry) => n + estimateOperatorMessageTokens(entry.text), 0))
  const opening = earlier.find(entry => entry.ordinal === 1)
  const carry: OperatorMessageEntry[] = []
  const admit = (entry: OperatorMessageEntry): boolean => {
    const tokens = estimateOperatorMessageTokens(entry.text)
    if (tokens > room) return false
    room -= tokens
    carry.push({ ordinal: entry.ordinal, text: entry.text })
    return true
  }
  if (opening !== undefined) admit(opening)
  for (const entry of [...earlier].reverse()) {
    if (entry.ordinal === 1) continue
    admit(entry)
  }
  selected.push(...carry)
  selected.sort((a, b) => b.ordinal - a.ordinal)
  if (selected.length === 0) return null
  return { type: OPERATOR_MESSAGES_ATTACHMENT_TYPE, messages: selected, omitted: prior + texts.length - selected.length }
}

function ordinalRanges(ordinals: number[]): string {
  const sorted = [...ordinals].sort((a, b) => a - b)
  const parts: string[] = []
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index]!
    let end = start
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index]!
    parts.push(start === end ? String(start) : `${start}-${end}`)
  }
  return parts.join(', ')
}

export function operatorMessagesBlockText(attachment: OperatorMessagesAttachment): string {
  const shown = attachment.messages.length
  const total = shown + attachment.omitted
  const present = new Set(attachment.messages.map(entry => entry.ordinal))
  const missing: number[] = []
  for (let ordinal = 1; ordinal <= total; ordinal++) if (!present.has(ordinal)) missing.push(ordinal)
  const coverage =
    attachment.omitted === 0
      ? `all ${total} of them`
      : `${shown} of ${total}; ${missing.length === 1 ? `message ${ordinalRanges(missing)} is` : `messages ${ordinalRanges(missing)} are`} carried whole by the earlier folds' boundary records`
  const head = `The operator's own messages from this stretch and the earlier folds, verbatim and newest first (${coverage}). They are the record of what was asked, in the operator's exact words; the summary says what was done about each and where the work stands.`
  const rows = attachment.messages.map(entry => `<operator-message ordinal="${entry.ordinal}" of="${total}">\n${entry.text}\n</operator-message>`)
  return [head, ...rows].join('\n\n')
}
