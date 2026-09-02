// Hook feedback formatters — the model-facing message shapes for blocking
// errors across hook families. The prefixes are contract text the model learns
// to react to; they hold still even as surrounding prose changes.

import type { HookBlockingError } from './types.js'

/** PreToolUse block, tagged with the family:tool hook name (e.g. 'PreToolUse:Write'). */
export function getPreToolHookBlockingMessage(
  hookName: string,
  blockingError: HookBlockingError,
): string {
  return `${hookName} hook error: ${blockingError.blockingError}`
}

/** Stop-hook feedback: the re-prompt a Stop hook uses to keep the turn going. */
export function getStopHookMessage(blockingError: HookBlockingError): string {
  return `Stop hook feedback:\n${blockingError.blockingError}`
}

/** TeammateIdle feedback, delivered when an idle check decides the teammate must act. */
export function getTeammateIdleHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TeammateIdle hook feedback:\n${blockingError.blockingError}`
}

/** TaskCreated feedback on a blocked task creation. */
export function getTaskCreatedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCreated hook feedback:\n${blockingError.blockingError}`
}

/** TaskCompleted feedback on a blocked completion. */
export function getTaskCompletedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCompleted hook feedback:\n${blockingError.blockingError}`
}

/** UserPromptSubmit block: what the operator sees in place of their submitted prompt. */
export function getUserPromptSubmitHookBlockingMessage(
  blockingError: HookBlockingError,
): string {
  return `UserPromptSubmit operation blocked by hook:\n${blockingError.blockingError}`
}
