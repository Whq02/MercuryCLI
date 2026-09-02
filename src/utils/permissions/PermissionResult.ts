/**
 * Re-export shim for the permission decision types, plus the prose word for a
 * rule behaviour. The types live in the cycle-breaking types module.
 */
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

/** The prose describing what a rule behaviour did, for user-facing text. */
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
