import type { Message } from '../../types/message.js'
import type { NormalizedMessage } from '../../types/message.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const NULL_RENDERING_ATTACHMENT_TYPES: Unbuilt = unbuilt('src/components/messages/nullRenderingAttachments.ts:5')

export type NullRenderingAttachmentType =
  (typeof NULL_RENDERING_ATTACHMENT_TYPES)[number]

const NULL_RENDERING_SET: ReadonlySet<string> = new Set(
  NULL_RENDERING_ATTACHMENT_TYPES,
)

export function isNullRenderingAttachment(
  message: Message | NormalizedMessage,
): boolean {
  if (message.type !== 'attachment') return false
  return NULL_RENDERING_SET.has(message.attachment.type)
}

export const NULL_RENDERING_SYSTEM_SUBTYPES = [
  'thinking_note',
  'thinking_dead',
] as const

const NULL_RENDERING_SYSTEM_SET: ReadonlySet<string> = new Set(
  NULL_RENDERING_SYSTEM_SUBTYPES,
)

const OVERLOADED_ANSWER_MARKER = '"type":"overloaded_error"'

export function isTransportRetryNotice(message: Message | NormalizedMessage): boolean {
  if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'api_error') return false
  const row = message as { errorDetail?: { status?: unknown; message?: unknown }; error?: { status?: unknown; message?: unknown } }
  const status = row.errorDetail?.status ?? row.error?.status
  if (typeof status === 'number') return false
  const words = [row.errorDetail?.message, row.error?.message].find(value => typeof value === 'string' && value !== '')
  return typeof words !== 'string' || !words.includes(OVERLOADED_ANSWER_MARKER)
}

export function isNullRenderingSystemRow(
  message: Message | NormalizedMessage,
): boolean {
  if (message.type !== 'system') return false
  if (isTransportRetryNotice(message)) return true
  return NULL_RENDERING_SYSTEM_SET.has(
    (message as { subtype?: string }).subtype ?? '',
  )
}
