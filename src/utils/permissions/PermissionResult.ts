export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionMetadata,
  PermissionResult,
} from '../../types/permissions.js'
import type { PermissionBehavior } from '../../types/permissions.js'
import { notBuilt } from '../../pi/holes.js'

export function getRuleBehaviorDescription(behavior: PermissionBehavior | 'passthrough'): string {
  return notBuilt('src/utils/permissions/PermissionResult.ts:12')
}
