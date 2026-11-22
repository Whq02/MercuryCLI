import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import { getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from './permissions.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ShadowType = 'ask' | 'deny'

export type UnreachableRule = Unbuilt

function isToolWide(rule: PermissionRule): boolean {
  return rule.ruleValue.ruleContent === undefined || rule.ruleValue.ruleContent === ''
}

export function detectUnreachableRules(context: ToolPermissionContext): UnreachableRule[] {
  return notBuilt('src/utils/permissions/shadowedRuleDetection.ts:19')
}
