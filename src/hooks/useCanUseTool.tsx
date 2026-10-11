import { useCallback } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionAskDecision, PermissionDecision } from '../types/permissions.js'
import { logError } from '../utils/log.js'
import { decideToolPermissionWithModes } from '../utils/permissions/decision/wrapper.js'
import { handleCoordinatorPermission } from './toolPermission/handlers/coordinatorHandler.js'
import { handleInteractivePermission } from './toolPermission/handlers/interactiveHandler.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
  type PermissionContext,
} from './toolPermission/PermissionContext.js'

export type CanUseToolFn<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = (
  tool: Tool,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision,
) => Promise<PermissionDecision>

const withdrawn = (ctx: PermissionContext): boolean => ctx.toolUseContext.abortController.signal.aborted

const cancelled = (ctx: PermissionContext): PermissionDecision => ctx.cancelAndAbort(undefined, true)

async function readDecision(ctx: PermissionContext, forced: PermissionDecision | undefined): Promise<PermissionDecision> {
  if (forced) return forced
  const { tool, input, toolUseContext, assistantMessage, toolUseID } = ctx
  const evaluated = await decideToolPermissionWithModes(tool, input, toolUseContext, assistantMessage, toolUseID)
  return evaluated.decision
}

function describeTool(ctx: PermissionContext): Promise<string> {
  const { tool, input, toolUseContext } = ctx
  return tool.description(input, {
    isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    toolPermissionContext: toolUseContext.getAppState().toolPermissionContext,
    tools: toolUseContext.options.tools,
  })
}

async function ask(ctx: PermissionContext, result: PermissionAskDecision, description: string): Promise<PermissionDecision> {
  const { awaitAutomatedChecksBeforeDialog, mode } = ctx.toolUseContext.getAppState().toolPermissionContext
  if (awaitAutomatedChecksBeforeDialog) {
    const automated = await handleCoordinatorPermission({
      ctx,
      updatedInput: result.updatedInput,
      suggestions: result.suggestions,
      permissionMode: mode,
    })
    if (automated) return automated
    if (withdrawn(ctx)) return cancelled(ctx)
  }
  return new Promise(resolve =>
    handleInteractivePermission(
      { ctx, description, result, awaitAutomatedChecksBeforeDialog, channelCallbacks: undefined },
      resolve,
    ),
  )
}

async function decide(ctx: PermissionContext, forced: PermissionDecision | undefined): Promise<PermissionDecision> {
  if (withdrawn(ctx)) return cancelled(ctx)
  const result = await readDecision(ctx, forced)
  if (result.behavior === 'allow') {
    if (withdrawn(ctx)) return cancelled(ctx)
    ctx.logDecision({ decision: 'accept', source: 'config' })
    return ctx.buildAllow(result.updatedInput ?? ctx.input, { decisionReason: result.decisionReason })
  }
  const description = await describeTool(ctx)
  if (withdrawn(ctx)) return cancelled(ctx)
  if (result.behavior === 'deny') {
    ctx.logDecision({ decision: 'reject', source: 'config' })
    return result
  }
  return ask(ctx, result, description)
}

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

export default function useCanUseTool(
  setToolUseConfirmQueue: (updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[]) => void,
  setToolPermissionContext: (next: ToolPermissionContext) => void,
): CanUseToolFn {
  return useCallback<CanUseToolFn>(
    async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
      const ctx = createPermissionContext(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        setToolPermissionContext,
        createPermissionQueueOps(setToolUseConfirmQueue),
      )
      return decide(ctx, forceDecision).catch((error: unknown) => {
        if (!isAbortError(error)) logError(error)
        return cancelled(ctx)
      })
    },
    [setToolUseConfirmQueue, setToolPermissionContext],
  )
}
