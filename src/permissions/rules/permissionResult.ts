export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionMetadata,
  PermissionResult,
} from './permissions.js'
import type { PermissionBehavior } from './permissions.js'

export function getRuleBehaviorDescription(behavior: PermissionBehavior | 'passthrough'): string {
  switch (behavior) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    case 'ask':
    case 'passthrough':
      return 'asked for confirmation for'
  }
}
