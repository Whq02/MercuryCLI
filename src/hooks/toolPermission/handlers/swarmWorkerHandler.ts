// Swarm-worker permission flow: forward the request to the team leader over
// the mailbox and await the leader's verdict. Returning null means "fall
// through to local interactive handling".

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
  /** Carried for call-shape compatibility; the classifier step is disabled. */
  pendingClassifierCheck?: PendingClassifierCheck
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

export async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, description, suggestions } = params
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) return null

  // The classifier auto-approval step sits here in shape; it currently
  // evaluates to no result.

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

      // Register the response callbacks BEFORE sending — the leader can
      // answer before registration otherwise.
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: ctx.toolUseID,
        onAllow: updatedInput => {
          // Claim before awaiting the allow path.
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

      // Fire-and-forget: a late mailbox failure cannot fall back, so it is
      // only logged.
      void Promise.resolve(sendPermissionRequestViaMailbox(request)).catch(
        error => logError(error),
      )

      // Show the operator that this worker is waiting on its leader.
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: {
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
        },
      }))

      // An abort while waiting must not hang the executor.
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
