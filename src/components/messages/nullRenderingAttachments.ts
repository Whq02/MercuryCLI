
import type { Message } from '../../types/message.js'
import type { NormalizedMessage } from '../../types/message.js'

export const NULL_RENDERING_ATTACHMENT_TYPES = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'taste_recall',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'todo_reminder',
  'context_efficiency',
  'deferred_tools_delta',
  'agent_roster',
  'mcp_instructions_delta',
  'harness_map_delta',
  'run_protocol_delta',
  'lane_boundary',
  'token_usage',
  'deepthink_effort',
  'ultra_effort',
  'ultra_effort_exit',
  'supercode_keyword',
  'repo_surface_map',
  'context_capsule',
  'bagel_console',
  'max_turns_reached',
  'repetition_breaker',
  'cycle_handoff',
  'task_reminder',
  'contract_reminder',
  'auto_mode',
  'auto_mode_exit',
  'mode_pack',
  'mode_pack_exit',
  'output_token_usage',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
  'user_context',
  'bound_prefix',
  'dead_thinking',
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

export function isNullRenderingSystemRow(
  message: Message | NormalizedMessage,
): boolean {
  if (message.type !== 'system') return false
  return NULL_RENDERING_SYSTEM_SET.has(
    (message as { subtype?: string }).subtype ?? '',
  )
}
