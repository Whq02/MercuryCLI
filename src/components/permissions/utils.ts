/**
 * The shared accept/reject telemetry emitter for consent cards. Language is
 * always reported as `none` on this path — cards that know a real language
 * (the file dialog) emit through their own handlers instead — and the
 * platform comes from the analytics-host resolver, not the raw process.
 */
import { getHostPlatformForAnalytics } from '../../utils/env.js'
import { logUnaryEvent, type CompletionType } from '../../utils/unaryLogging.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export function logUnaryPermissionEvent(
  completionType: CompletionType,
  toolUseConfirm: ToolUseConfirm,
  event: 'accept' | 'reject',
  hasFeedback: boolean = false,
): void {
  void logUnaryEvent({
    event,
    completion_type: completionType,
    metadata: {
      language_name: 'none',
      message_id: toolUseConfirm.assistantMessage.message.id,
      platform: getHostPlatformForAnalytics(),
      hasFeedback,
    },
  })
}
