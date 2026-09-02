
import type { PendingClassifierCheck, PermissionDecision, PermissionMode, PermissionUpdate } from '../../../types/permissions.js'
import { logError } from '../../../utils/log.js'
import type { PermissionContext } from '../PermissionContext.js'

export type CoordinatorPermissionParams = {
  ctx: PermissionContext
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
  } catch (error) {
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
