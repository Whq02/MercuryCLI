// Coordinator-worker permission flow: automated checks are AWAITED before the
// dialog is shown. Returning null means "show the dialog" — the hooks have
// already run here and must not run again there.

import type { PendingClassifierCheck, PermissionDecision, PermissionMode, PermissionUpdate } from '../../../types/permissions.js'
import { logError } from '../../../utils/log.js'
import type { PermissionContext } from '../PermissionContext.js'

export type CoordinatorPermissionParams = {
  ctx: PermissionContext
  /** Carried for call-shape compatibility; the classifier step is disabled. */
  pendingClassifierCheck?: PendingClassifierCheck
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
  permissionMode: PermissionMode
}

export async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, permissionMode, suggestions, updatedInput } = params
  try {
    const hookDecision = await ctx.runHooks(permissionMode, suggestions, updatedInput)
    if (hookDecision) return hookDecision
    // The classifier step sits here in shape; it currently evaluates to no
    // result, so execution always falls through to the dialog.
  } catch (error) {
    // Non-Error throws are wrapped with the failure context by hand — the
    // generic error coercion would drop it.
    logError(
      error instanceof Error
        ? error
        : new Error(
            `Coordinator permission automated checks failed: ${String(error)}`,
          ),
    )
  }
  return null
}
