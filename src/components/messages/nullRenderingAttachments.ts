
import type { Message } from '../../types/message.js'
import type { NormalizedMessage } from '../../types/message.js'

export const NULL_RENDERING_ATTACHMENT_TYPES = [
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'open_files_in_ide',
  'structured_output',
  'context_efficiency',
  'deferred_tools_delta',
  'held_tools',
  'tool_schema_delta',
  'agent_roster',
  'mcp_instructions_delta',
  'mcp_servers_failed',
  'harness_map_delta',
  'context_capsule',
  'bagel_console',
  'max_turns_reached',
  'loop_stopped',
  'task_reminder',
  'contract_reminder',
  'mode_pack',
  'mode_pack_exit',
  'output_token_usage',
  'usage_limit_notice',
  'verify_plan_reminder',
  'current_session_memory',
  'date_change',
  'user_context',
  'bound_prefix',
  'dead_thinking',
  'images_left_out',
  'compact_operator_messages',
] as const

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
