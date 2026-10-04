import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { HookJSONOutputSchema, SyncHookJSONOutputSchema, type AsyncHookJSONOutput, type HookEvent, type HookInput, type HookJSONOutput, type SyncHookJSONOutput } from '../utils/hooks/contract.js'
import { permissionUpdateSchema } from '../utils/permissions/PermissionUpdateSchema.js'
import type { PermissionUpdate } from './permissions.js'
import type { AppState } from '../state/AppState.js'


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

export const syncHookResponseSchema = SyncHookJSONOutputSchema
export const hookJSONOutputSchema = HookJSONOutputSchema

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

export type HookBlockingError = import('../utils/hooks/types.js').HookBlockingError

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

export type HookResult = import('../utils/hooks/types.js').HookResult

export type AggregatedHookResult = import('../utils/hooks/types.js').AggregatedHookResult
