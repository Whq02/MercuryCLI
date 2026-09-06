import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import {
  HOOK_EVENTS,
  type AsyncHookJSONOutput,
  type HookEvent,
  type HookInput,
  type HookJSONOutput,
  type SyncHookJSONOutput,
} from '../entrypoints/agentSdkTypes.js'
import { PermissionUpdateSchema } from '../entrypoints/sdk/coreSchemas.js'
import type { PermissionUpdate } from './permissions.js'
import type { AppState } from '../state/AppState.js'

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value)
}

export const promptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z.string().describe('The request id.'),
    message: z.string(),
    options: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
)

export type PromptRequest = z.infer<ReturnType<typeof promptRequestSchema>>

export type PromptResponse = {
  prompt_response: string
  selected: string
}

const preToolUseOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  }),
)
const userPromptSubmitOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('UserPromptSubmit'),
    additionalContext: z.string().optional(),
  }),
)
const sessionStartOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string().optional(),
    initialUserMessage: z.string().optional(),
    watchPaths: z.array(z.string()).optional().describe('Absolute paths to watch for file-changed hooks.'),
  }),
)
const setupOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Setup'),
    additionalContext: z.string().optional(),
  }),
)
const subagentStartOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SubagentStart'),
    additionalContext: z.string().optional(),
  }),
)
const postToolUseOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().optional(),
    updatedMCPToolOutput: z.unknown().optional(),
  }),
)
const postToolUseFailureOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUseFailure'),
    additionalContext: z.string().optional(),
  }),
)
const permissionDeniedOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionDenied'),
    retry: z.boolean().optional(),
  }),
)
const notificationOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Notification'),
    additionalContext: z.string().optional(),
  }),
)
const permissionRequestOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: z.union([
      z.object({
        behavior: z.literal('allow'),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
        updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
      }),
      z.object({
        behavior: z.literal('deny'),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
      }),
    ]),
  }),
)
const elicitationOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Elicitation'),
    action: z.enum(['accept', 'decline', 'cancel']).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
)
const elicitationResultOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('ElicitationResult'),
    action: z.enum(['accept', 'decline', 'cancel']).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
)
const cwdChangedOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('CwdChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)
const fileChangedOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('FileChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)
const worktreeCreateOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('WorktreeCreate'),
    worktreePath: z.string(),
  }),
)

export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z
      .boolean()
      .optional()
      .describe('Whether the harness continues after this hook (default true).'),
    suppressOutput: z
      .boolean()
      .optional()
      .describe('Hide the hook stdout from the transcript (default false).'),
    stopReason: z
      .string()
      .optional()
      .describe('Message shown when continue is false.'),
    decision: z.literal('block').optional(),
    reason: z.string().optional(),
    systemMessage: z
      .string()
      .optional()
      .describe('Warning shown to the user.'),
    hookSpecificOutput: z
      .union([
        preToolUseOutputSchema(),
        userPromptSubmitOutputSchema(),
        sessionStartOutputSchema(),
        setupOutputSchema(),
        subagentStartOutputSchema(),
        postToolUseOutputSchema(),
        postToolUseFailureOutputSchema(),
        permissionDeniedOutputSchema(),
        notificationOutputSchema(),
        permissionRequestOutputSchema(),
        elicitationOutputSchema(),
        elicitationResultOutputSchema(),
        cwdChangedOutputSchema(),
        fileChangedOutputSchema(),
        worktreeCreateOutputSchema(),
      ])
      .optional(),
  }),
)

const asyncHookResponseSchema = lazySchema(() =>
  z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  }),
)

export const hookJSONOutputSchema = lazySchema(() =>
  z.union([asyncHookResponseSchema(), syncHookResponseSchema()]),
)

export function isAsyncHookJSONOutput(
  json: HookJSONOutput | undefined,
): json is AsyncHookJSONOutput {
  return json !== undefined && 'async' in json && json.async === true
}

export function isSyncHookJSONOutput(
  json: HookJSONOutput | undefined,
): json is SyncHookJSONOutput {
  return json !== undefined && !isAsyncHookJSONOutput(json)
}

type IsEqual<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T
export type HookOutputContractCheck = Assert<
  IsEqual<z.infer<ReturnType<typeof hookJSONOutputSchema>>, HookJSONOutput>
>


export type HookCallbackContext = {
  getAppState: () => AppState
  updateAttributionState: (updater: (prev: unknown) => unknown) => void
}

export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    signal?: AbortSignal,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean
}

export type HookCallbackMatcher = {
  matcher?: string
  hooks: HookCallback[]
  extension?: string
}

export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

export type HookBlockingError = {
  blockingError: string
  command: string
}

export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }

export type HookResult = {
  message?: unknown
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
  retry?: boolean
}

export type AggregatedHookResult = {
  message?: unknown
  blockingErrors: HookBlockingError[]
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}
