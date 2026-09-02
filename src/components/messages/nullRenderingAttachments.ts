// The registry of attachment types that render nothing under all runtime
// conditions, plus the membership predicate. The transcript drops these
// entries ahead of both its message count and its render window, so an
// invisible entry can neither raise the reported count nor occupy a
// rendered slot. Synchronisation with the attachment dispatcher is enforced
// by the type system: the dispatcher's default branch asserts membership,
// so a new attachment type without either a render case or a registry entry
// fails typecheck.

import type { Message } from '../../types/message.js'
import type { NormalizedMessage } from '../../types/message.js'

/** Contract data — attachment type tokens shared with the attachment union. */
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
  'mcp_instructions_delta',
  'harness_map_delta',
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
  'output_token_usage',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
  'user_context',
] as const

export type NullRenderingAttachmentType =
  (typeof NULL_RENDERING_ATTACHMENT_TYPES)[number]

// Built once; the predicate runs for every message on every transcript pass.
const NULL_RENDERING_SET: ReadonlySet<string> = new Set(
  NULL_RENDERING_ATTACHMENT_TYPES,
)

/** True when the message is an attachment whose type renders nothing; false
 *  for anything that is not an attachment. */
export function isNullRenderingAttachment(
  message: Message | NormalizedMessage,
): boolean {
  if (message.type !== 'attachment') return false
  return NULL_RENDERING_SET.has(message.attachment.type)
}
