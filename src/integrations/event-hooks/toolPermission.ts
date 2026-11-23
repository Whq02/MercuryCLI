import type { hasPermissionsToUseTool } from '../../permissions/rules/permissionDoor.js'

type DecidesToolPermission = typeof hasPermissionsToUseTool

let howAToolIsPermitted: DecidesToolPermission | undefined

export function tellHooksHowAToolIsPermitted(decide: DecidesToolPermission): void {
  howAToolIsPermitted = decide
}

export const toolPermissionForHooks: DecidesToolPermission = (...call) => howAToolIsPermitted!(...call)
