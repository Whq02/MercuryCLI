// The hook vocabulary — result/aggregation shapes, blocking errors, and the
// event-specific result types shared across the engine submodules. Owned
// Mercury module.

import type { ElicitResult } from '../../services/mcp/sdk.js'
import type {
  PermissionRequestResult,
  HookCallback,
} from '../../types/hooks.js'
import type { HookResultMessage } from 'src/types/message.js'
import type { HookCommand } from '../settings/types.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'
import type { FunctionHook } from './sessionHooks.js'

export interface HookBlockingError {
  blockingError: string
  command: string
  /**
   * When true, the blocking-error text is a MODEL-FACING re-prompt that must NOT
   * surface in the front-end transcript: the consumer (handleStopHooks) still
   * injects the isMeta user message so the model receives the nudge, but skips
   * the visible "Stop hook error" summary line + the error notification. Set by a
   * FunctionHook carrying `silent: true` (e.g. the Fable
   * keep-working hooks). Mercury-only; absent ⇒ a bare stamp behavior is byte-identical.
   */
  silent?: boolean
}

/** The MCP SDK's ElicitResult under the name Mercury's hook shapes settled on. */
export type ElicitationResponse = ElicitResult

export interface HookResult {
  message?: HookResultMessage
  systemMessage?: string
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: ElicitationResponse
  watchPaths?: string[]
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  hook: HookCommand | HookCallback | FunctionHook
}

export type AggregatedHookResult = {
  message?: HookResultMessage
  blockingError?: HookBlockingError
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  hookSource?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  watchPaths?: string[]
  elicitationResponse?: ElicitationResponse
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
}

export type HookOutsideReplResult = {
  command: string
  succeeded: boolean
  output: string
  blocked: boolean
  watchPaths?: string[]
  systemMessage?: string
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'


export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'


/** What an Elicitation hook run yields outside the REPL: a response, a block, or neither. */
export type ElicitationHookResult = {
  elicitationResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** What an ElicitationResult hook run yields outside the REPL. */
export type ElicitationResultHookResult = {
  elicitationResultResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

