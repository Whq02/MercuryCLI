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

export function getRuleBehaviorDescription(behavior: PermissionBehavior | 'passthrough'): string {
  switch (behavior) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
