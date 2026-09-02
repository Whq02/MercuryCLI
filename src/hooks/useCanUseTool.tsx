// The REPL's permission function. One per-call context bundles the
// queue verbs and the permission-context setter; the decision is the forced
// one when supplied, otherwise the configured evaluation. Abort is
// re-checked at EVERY await boundary, not only at entry — a user who
// cancels while the description renders must not still be asked. The ask
// path offers the request to the coordinator handler (only when the
// permission context awaits automated checks before dialogs), then the
// swarm-worker handler, then the interactive dialog. The tool-use id's
// classifier-checking marker is cleared on completion in ALL cases.

import { useCallback } from 'react'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../types/permissions.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { clearClassifierChecking } from '../utils/classifierApprovals.js'
import { logError } from '../utils/log.js'
import { decideToolPermissionWithModes } from '../utils/permissions/decision/wrapper.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
} from './toolPermission/PermissionContext.js'
import { handleCoordinatorPermission } from './toolPermission/handlers/coordinatorHandler.js'
import { handleSwarmWorkerPermission } from './toolPermission/handlers/swarmWorkerHandler.js'
import { handleInteractivePermission } from './toolPermission/handlers/interactiveHandler.js'

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

export default function useCanUseTool(
  setToolUseConfirmQueue: (
    updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void,
  setToolPermissionContext: (next: ToolPermissionContext) => void,
): CanUseToolFn {
  return useCallback<CanUseToolFn>(
    (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) =>
      new Promise<PermissionDecision>(resolve => {
        const ctx = createPermissionContext(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
          setToolPermissionContext,
          createPermissionQueueOps(setToolUseConfirmQueue),
        )
        void (async () => {
          try {
            if (ctx.resolveIfAborted(resolve)) return

            const result =
              forceDecision ??
              (
                await decideToolPermissionWithModes(
                  tool,
                  input,
                  toolUseContext,
                  assistantMessage,
                  toolUseID,
                )
              ).decision

            if (result.behavior === 'allow') {
              if (ctx.resolveIfAborted(resolve)) return
              ctx.logDecision({ decision: 'accept', source: 'config' })
              resolve(
                ctx.buildAllow(result.updatedInput ?? input, {
                  decisionReason: result.decisionReason,
                }),
              )
              return
            }

            const description = await tool.description(input, {
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              toolPermissionContext:
                toolUseContext.getAppState().toolPermissionContext,
              tools: toolUseContext.options.tools,
            })
            if (ctx.resolveIfAborted(resolve)) return

            if (result.behavior === 'deny') {
              ctx.logDecision({ decision: 'reject', source: 'config' })
              resolve(result)
              return
            }

            // Ask. Coordinator first, only when the permission context awaits
            // automated checks before dialogs.
            const permissionContext =
              toolUseContext.getAppState().toolPermissionContext
            if (permissionContext.awaitAutomatedChecksBeforeDialog) {
              const coordinatorDecision = await handleCoordinatorPermission({
                ctx,
                // The dead pending-classifier-check slot rides as an empty
                // spread — call-shape compatibility with S29's handlers.
                ...{},
                updatedInput: result.updatedInput,
                suggestions: result.suggestions,
                permissionMode: permissionContext.mode,
              })
              if (coordinatorDecision) {
                resolve(coordinatorDecision)
                return
              }
              if (ctx.resolveIfAborted(resolve)) return
            }

            const workerDecision = await handleSwarmWorkerPermission({
              ctx,
              description,
              ...{},
              updatedInput: result.updatedInput,
              suggestions: result.suggestions,
            })
            if (workerDecision) {
              resolve(workerDecision)
              return
            }
            if (ctx.resolveIfAborted(resolve)) return

            handleInteractivePermission(
              {
                ctx,
                description,
                result,
                awaitAutomatedChecksBeforeDialog:
                  permissionContext.awaitAutomatedChecksBeforeDialog,
                channelCallbacks: undefined,
              },
              resolve,
            )
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              ctx.logCancelled()
            } else {
              logError(error)
            }
            resolve(ctx.cancelAndAbort(undefined, true))
          } finally {
            clearClassifierChecking(toolUseID)
          }
        })()
      }),
    [setToolUseConfirmQueue, setToolPermissionContext],
  )
}
