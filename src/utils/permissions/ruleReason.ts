import { getToolNameForPermissionCheck, mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionBehavior, PermissionRule, PermissionRuleSource, PermissionRuleValue } from '../../types/permissions.js'
import { getDenyRules } from './decision/rules.js'
import { RULE_INHERITS } from '../../constants/tools.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'

export type RuleReasonCarrier = {
  readonly ruleReasons?: { readonly [K in PermissionRuleSource]?: { readonly [spelling: string]: string } }
}

const RULE_SOURCE_WORDS: Record<PermissionRuleSource, string> = {
  userSettings: 'in your user settings',
  projectSettings: 'in the shared project settings',
  localSettings: 'in the project local settings',
  flagSettings: 'in the settings file named on the command line',
  policySettings: 'in the managed settings',
  cliArg: 'from the command line',
  command: "from the command's own rules",
  session: 'from this session',
  toolsNarrowing: 'from the tool set',
  mcpServerPolicy: 'from the MCP server policy',
}

export function ruleSpelling(value: PermissionRuleValue): string {
  return permissionRuleValueToString(value)
}

export function ruleSourceWords(source: PermissionRuleSource): string {
  return RULE_SOURCE_WORDS[source]
}

export function ruleWords(rule: Pick<PermissionRule, 'source' | 'ruleValue'>): string {
  return `the rule ${ruleSpelling(rule.ruleValue)} ${ruleSourceWords(rule.source)}`
}

export function ruleSentence(subject: string, verdict: PermissionBehavior, rule: Pick<PermissionRule, 'source' | 'ruleValue'>): string {
  const words = ruleWords(rule)
  if (verdict === 'deny') return `${subject} is denied by ${words}.`
  if (verdict === 'ask') return `${subject} asks first — ${words}.`
  return `${subject} is allowed by ${words}.`
}

export function normaliseRuleReasons(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || key.trim() === '') continue
    const words = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (words === '') continue
    out[ruleSpelling(permissionRuleValueFromString(key))] = words
  }
  return out
}

export function reasonForRule(carrier: RuleReasonCarrier, rule: PermissionRule): string | undefined {
  if (rule.ruleValue.reason !== undefined) return rule.ruleValue.reason
  return carrier.ruleReasons?.[rule.source]?.[ruleSpelling(rule.ruleValue)]
}

export function ruleSpecificity(value: PermissionRuleValue): number {
  const spelling = ruleSpelling(value)
  const star = spelling.indexOf('*')
  return star === -1 ? spelling.length : star
}

export function mostSpecificReason(
  carrier: RuleReasonCarrier,
  decided: PermissionRule,
  matches: () => readonly PermissionRule[],
): string | undefined {
  if (carrier.ruleReasons === undefined) return decided.ruleValue.reason
  let best = reasonForRule(carrier, decided)
  let bestRank = best === undefined ? -1 : ruleSpecificity(decided.ruleValue)
  for (const rule of matches()) {
    const reason = reasonForRule(carrier, rule)
    if (reason === undefined) continue
    const rank = ruleSpecificity(rule.ruleValue)
    if (rank > bestRank) {
      best = reason
      bestRank = rank
    }
  }
  return best
}

export function withRuleReason(
  carrier: RuleReasonCarrier,
  decided: PermissionRule,
  matches: () => readonly PermissionRule[],
): PermissionRule {
  const reason = mostSpecificReason(carrier, decided, matches)
  if (reason === undefined || decided.ruleValue.reason === reason) return decided
  return { ...decided, ruleValue: { ...decided.ruleValue, reason } }
}

export function refusalWithReason(sentence: string, reason: string | undefined): string {
  if (reason === undefined) return sentence
  const head = sentence.endsWith('.') ? sentence.slice(0, -1) : sentence
  return `${head}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`
}

export function wholeToolDenyRulesCovering(
  context: ToolPermissionContext,
  tool: { name: string; mcpInfo?: { serverName: string; toolName: string } },
): PermissionRule[] {
  const name = getToolNameForPermissionCheck(tool)
  const toolInfo = mcpInfoFromString(name)
  return getDenyRules(context).filter(rule => {
    if (rule.ruleValue.ruleContent !== undefined) return false
    if (rule.ruleValue.toolName === name || RULE_INHERITS[name]?.includes(rule.ruleValue.toolName)) return true
    const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
    return (
      ruleInfo !== null &&
      toolInfo !== null &&
      (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
      ruleInfo.serverName === toolInfo.serverName
    )
  })
}
