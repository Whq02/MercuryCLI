import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import type { PermissionRule } from './permissions.js'
import { getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from './permissionDoor.js'

type ShadowType = 'ask' | 'deny'

export type UnreachableRule = {
  rule: PermissionRule
  shadowedBy: PermissionRule
  reason: string
  fix: string
  shadowType: ShadowType
}

function isToolWide(rule: PermissionRule): boolean {
  return rule.ruleValue.ruleContent === undefined || rule.ruleValue.ruleContent === ''
}

export function detectUnreachableRules(context: ToolPermissionContext): UnreachableRule[] {
  const allowRules = getAllowRules(context)
  const denyRules = getDenyRules(context)
  const askRules = getAskRules(context)

  const toolWideDenyByTool = new Map<string, PermissionRule>()
  for (const rule of denyRules) {
    if (isToolWide(rule) && !toolWideDenyByTool.has(rule.ruleValue.toolName)) {
      toolWideDenyByTool.set(rule.ruleValue.toolName, rule)
    }
  }

  const toolWideAskByTool = new Map<string, PermissionRule>()
  for (const rule of askRules) {
    if (isToolWide(rule) && !toolWideAskByTool.has(rule.ruleValue.toolName)) {
      toolWideAskByTool.set(rule.ruleValue.toolName, rule)
    }
  }

  const findings: UnreachableRule[] = []
  for (const rule of allowRules) {
    if (isToolWide(rule)) continue
    const toolName = rule.ruleValue.toolName
    const denyShadow = toolWideDenyByTool.get(toolName)
    const askShadow = denyShadow ? undefined : toolWideAskByTool.get(toolName)
    const shadowedBy = denyShadow ?? askShadow
    if (!shadowedBy) continue

    const shadowType: ShadowType = denyShadow ? 'deny' : 'ask'
    const shadowingSource = permissionRuleSourceDisplayString(shadowedBy.source)
    const shadowedSource = permissionRuleSourceDisplayString(rule.source)
    const outcome = shadowType === 'deny' ? 'denied' : 'asked about first'

    findings.push({
      rule,
      shadowedBy,
      reason: `${toolName} is always ${outcome} by a tool-wide ${shadowType} rule from ${shadowingSource}, so this allow rule can never take effect.`,
      fix: `Remove the tool-wide ${shadowType} rule for ${toolName} from ${shadowingSource}, or remove this specific allow rule from ${shadowedSource}.`,
      shadowType,
    })
  }

  return findings
}
