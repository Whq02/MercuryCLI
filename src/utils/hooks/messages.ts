import { hookEventTable } from './contract.js'
import type { HookBlockingError } from './types.js'

export function getPreToolHookBlockingMessage(hookName: string, blockingError: HookBlockingError): string {
  return hookEventTable.PreToolUse.feedback!(blockingError.blockingError, hookName)
}

export function getStopHookMessage(blockingError: HookBlockingError): string {
  return hookEventTable.Stop.feedback!(blockingError.blockingError)
}


export function getTaskCreatedHookMessage(blockingError: HookBlockingError): string {
  return hookEventTable.TaskCreated.feedback!(blockingError.blockingError)
}

export function getTaskCompletedHookMessage(blockingError: HookBlockingError): string {
  return hookEventTable.TaskCompleted.feedback!(blockingError.blockingError)
}

export function getUserPromptSubmitHookBlockingMessage(blockingError: HookBlockingError): string {
  return hookEventTable.UserPromptSubmit.feedback!(blockingError.blockingError)
}
