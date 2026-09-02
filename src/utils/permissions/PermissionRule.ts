/**
 * Re-export shim for the rule types, plus lazily-constructed zod schemas for
 * rule behaviour and rule value.
 */
import { z } from 'zod/v4'

export type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from '../../types/permissions.js'

/** Lazy zod enum over the three behaviours (built on first use). */
export function permissionBehaviorSchema() {
  return z.enum(['allow', 'deny', 'ask'])
}

/** Lazy zod object for a rule value: a tool name and optional rule content. */
export function permissionRuleValueSchema() {
  return z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  })
}
