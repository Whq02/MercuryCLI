import { z } from 'zod/v4'

export type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from '../../types/permissions.js'

export function permissionBehaviorSchema() {
  return z.enum(['allow', 'deny', 'ask'])
}

export function permissionRuleValueSchema() {
  return z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  })
}
