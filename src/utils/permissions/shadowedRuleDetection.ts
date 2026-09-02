import type { ToolPermissionContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { PermissionRule, PermissionRuleSource } from '../../types/permissions.js'
import { getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from './permissions.js'

export type ShadowType = 'ask' | 'deny'

export type UnreachableRule = {
  rule: PermissionRule
  reason: string
  shadowedBy: PermissionRule
  shadowType: ShadowType
  fix: string
}

export type DetectUnreachableRulesOptions = {
  sandboxAutoAllowEnabled: boolean
}

const SHARED_SOURCES: ReadonlySet<PermissionRuleSource> = new Set<PermissionRuleSource>([
  'projectSettings',
  'policySettings',
  'command',
])

export function isSharedSettingSource(source: PermissionRuleSource): boolean {
  return SHARED_SOURCES.has(source)
}

function isToolWide(rule: PermissionRule): boolean {
  return rule.ruleValue.ruleContent === undefined || rule.ruleValue.ruleContent === ''
}

export function detectUnreachableRules(
  context: ToolPermissionContext,
  options: DetectUnreachableRulesOptions,
): UnreachableRule[] {
  const allowRules = getAllowRules(context)
  const denyRules = getDenyRules(context)
  const askRules = getAskRules(context)

  const findings: UnreachableRule[] = []

  for (const allow of allowRules) {
    if (isToolWide(allow)) continue
    const toolName = allow.ruleValue.toolName

    const denyShadow = denyRules.find(
      rule => rule.ruleValue.toolName === toolName && isToolWide(rule),
    )
    if (denyShadow) {
      findings.push(makeFinding(allow, denyShadow, 'deny'))
      continue
    }

    const askShadow = askRules.find(rule => rule.ruleValue.toolName === toolName && isToolWide(rule))
    if (askShadow) {
      if (
        options.sandboxAutoAllowEnabled &&
        toolName === BASH_TOOL_NAME &&
        !isSharedSettingSource(askShadow.source)
      ) {
        continue
      }
      findings.push(makeFinding(allow, askShadow, 'ask'))
    }
  }

  return findings
}

function makeFinding(
  rule: PermissionRule,
  shadowedBy: PermissionRule,
  shadowType: ShadowType,
): UnreachableRule {
  const toolName = shadowedBy.ruleValue.toolName
  const shadowingSource = permissionRuleSourceDisplayString(shadowedBy.source)
  const shadowedSource = permissionRuleSourceDisplayString(rule.source)
  const verb = shadowType === 'deny' ? 'denied' : 'asked about first'
  const reason = `${toolName} is always ${verb} by a tool-wide ${shadowType} rule from ${shadowingSource}, so this allow rule can never take effect.`
  const fix = `Remove the tool-wide ${shadowType} rule for ${toolName} from ${shadowingSource}, or remove this specific allow rule from ${shadowedSource}.`
  return { rule, reason, shadowedBy, shadowType, fix }
}
