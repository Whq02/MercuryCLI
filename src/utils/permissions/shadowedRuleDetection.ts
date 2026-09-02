/**
 * Detects allow rules made unreachable by tool-wide ask/deny rules, with an
 * explanation and a fix.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { PermissionRule, PermissionRuleSource } from '../../types/permissions.js'
import { getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from './permissions.js'

/** deny is more severe (always denied); ask always prompts first. */
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

/** Shared sources are visible to teammates; personal ones are the user's own. */
export function isSharedSettingSource(source: PermissionRuleSource): boolean {
  return SHARED_SOURCES.has(source)
}

/** A tool-wide rule has no content after parsing. */
function isToolWide(rule: PermissionRule): boolean {
  return rule.ruleValue.ruleContent === undefined || rule.ruleValue.ruleContent === ''
}

/** Detect allow rules that can never be reached. */
export function detectUnreachableRules(
  context: ToolPermissionContext,
  options: DetectUnreachableRulesOptions,
): UnreachableRule[] {
  const allowRules = getAllowRules(context)
  const denyRules = getDenyRules(context)
  const askRules = getAskRules(context)

  const findings: UnreachableRule[] = []

  for (const allow of allowRules) {
    // Only specific allow rules (with content) can be shadowed.
    if (isToolWide(allow)) continue
    const toolName = allow.ruleValue.toolName

    // Deny shadowing is checked first and suppresses the ask check.
    const denyShadow = denyRules.find(
      rule => rule.ruleValue.toolName === toolName && isToolWide(rule),
    )
    if (denyShadow) {
      findings.push(makeFinding(allow, denyShadow, 'deny'))
      continue
    }

    const askShadow = askRules.find(rule => rule.ruleValue.toolName === toolName && isToolWide(rule))
    if (askShadow) {
      // Sandbox exception for the Bash tool: a tool-wide ask rule from a
      // PERSONAL source does not shadow when sandbox auto-allow is enabled.
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
