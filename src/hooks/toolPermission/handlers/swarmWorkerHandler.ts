
import { registerPermissionCallback } from '../../../hooks/useSwarmPermissionPoller.js'
import type {
  PendingClassifierCheck,
  PermissionDecision,
  PermissionUpdate,
} from '../../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js'
import { logError } from '../../../utils/log.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
} from '../../../utils/swarm/permissionSync.js'
import { createResolveOnce, type PermissionContext } from '../PermissionContext.js'

export type SwarmWorkerPermissionParams = {
  ctx: PermissionContext
  description: string
  pendingClassifierCheck?: PendingClassifierCheck
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

export async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, description, suggestions } = params
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) return null


  try {
    const signal = ctx.toolUseContext.abortController.signal

    return await new Promise<PermissionDecision>(resolvePromise => {
      const guard = createResolveOnce(resolvePromise)

      const clearPendingIndicator = (): void => {
        ctx.toolUseContext.setAppState(prev => ({
          ...prev,
          pendingWorkerRequest: null,
        }))
      }

      const request = createPermissionRequest({
        toolName: ctx.tool.name,
        toolUseId: ctx.toolUseID,
        input: ctx.input,
        description,
        permissionSuggestions: suggestions,
      })

      registerPermissionCallback({
        requestId: request.id,
        toolUseId: ctx.toolUseID,
        onAllow: updatedInput => {
          if (!guard.claim()) return
          clearPendingIndicator()
          const finalInput =
            updatedInput &&
            typeof updatedInput === 'object' &&
            Object.keys(updatedInput).length > 0
              ? (updatedInput as Record<string, unknown>)
              : ctx.input
          void ctx
            .handleUserAllow(finalInput, [])
            .then(decision => guard.resolve(decision))
        },
        onReject: feedback => {
          if (!guard.claim()) return
          clearPendingIndicator()
          ctx.logDecision({
            decision: 'reject',
            source: {
              type: 'userReject',
              hasFeedback: Boolean(feedback && feedback.trim()),
            },
          })
          guard.resolve(ctx.cancelAndAbort(feedback))
        },
      })

      void Promise.resolve(sendPermissionRequestViaMailbox(request)).catch(
        error => logError(error),
      )

      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: {
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
        },
      }))

      signal.addEventListener(
        'abort',
        () => {
          if (!guard.claim()) return
          clearPendingIndicator()
          guard.resolve(ctx.cancelAndAbort(undefined, true))
        },
        { once: true },
      )
    })
  } catch (error) {
    logError(error)
    return null
  }
}
