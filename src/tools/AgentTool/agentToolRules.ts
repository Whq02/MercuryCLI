import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import { validatePermissionRule } from '../../utils/settings/permissionValidation.js'
import { AGENT_TOOL_NAME } from './constants.js'

export function agentToolRuleProblem(spec: string): string | null {
  if (!/[()]/.test(spec)) return null
  const validation = validatePermissionRule(spec)
  if (!validation.valid) return validation.error ?? 'Invalid permission rule'
  const rule = permissionRuleValueFromString(spec)
  if (/[()\s]/.test(rule.toolName) || !spec.trim().endsWith(')')) {
    return `Rule ${JSON.stringify(spec)} must name one tool followed by its pattern in parentheses`
  }
  return null
}

export function scopedAgentToolRules(definition: { tools?: readonly string[]; disallowedTools?: readonly string[] }): { allow: string[]; deny: string[] } {
  const bareTools = new Set(
    (definition.tools ?? [])
      .filter(spec => agentToolRuleProblem(spec) === null)
      .map(spec => permissionRuleValueFromString(spec))
      .filter(rule => rule.ruleContent === undefined)
      .map(rule => rule.toolName),
  )
  const scoped = (specs: readonly string[] | undefined, skipBare: boolean): string[] => (specs ?? []).filter(spec => {
    const problem = agentToolRuleProblem(spec)
    if (problem !== null) throw new Error(problem)
    const rule = permissionRuleValueFromString(spec)
    if (skipBare && (bareTools.has('*') || bareTools.has(rule.toolName))) return false
    return rule.ruleContent !== undefined && rule.toolName !== AGENT_TOOL_NAME
  })
  return { allow: scoped(definition.tools, true), deny: scoped(definition.disallowedTools, false) }
}
