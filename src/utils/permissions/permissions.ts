import { logForDebugging } from '../debug.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionRule,
  PermissionRuleSource,
  PermissionUpdate,
} from '../../types/permissions.js'
import { decideRuleBasedPermissions } from './decision/engine.js'
import { decideToolPermissionWithModes } from './decision/wrapper.js'
import {
  deletePermissionRuleFromSettings,
  shouldAllowManagedPermissionRulesOnly,
  type PermissionRuleFromEditableSettings,
} from './permissionsLoader.js'
import { applyPermissionUpdate, applyPermissionUpdates } from './PermissionUpdate.js'

export { guardHookUpdatedInput } from './decision/wrapper.js'
export { createPermissionRequestMessage } from './decision/requestMessage.js'
export { addPermissionRulesToSettings } from './permissionsLoader.js'
export {
  filterDeniedAgents,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForTool,
  getRuleByContentsForToolName,
  permissionRuleSourceDisplayString,
  toolAlwaysAllowedRule,
} from './decision/rules.js'

const BEHAVIORS: readonly PermissionBehavior[] = ['allow', 'deny', 'ask']
const DISK_SOURCES: readonly PermissionRuleSource[] = ['userSettings', 'projectSettings', 'localSettings']
const SESSION_SOURCES: readonly PermissionRuleSource[] = [...DISK_SOURCES, 'cliArg', 'session']
const READ_ONLY_SOURCES: ReadonlySet<PermissionRuleSource> = new Set(['policySettings', 'flagSettings', 'command'])

type RuleListUpdate = Extract<PermissionUpdate, { rules: unknown }>

const ruleListUpdate = (
  type: RuleListUpdate['type'],
  source: PermissionRuleSource,
  behavior: PermissionBehavior,
  rules: PermissionRule['ruleValue'][],
): PermissionUpdate => ({ type, rules, behavior, destination: source }) as never

const clearingOf = (sources: readonly PermissionRuleSource[]): PermissionUpdate[] =>
  sources.flatMap(source => BEHAVIORS.map(behavior => ruleListUpdate('replaceRules', source, behavior, [])))

function groupedBySourceAndBehavior(rules: PermissionRule[], type: RuleListUpdate['type']): PermissionUpdate[] {
  const groups = new Map<string, RuleListUpdate>()
  for (const rule of rules) {
    const key = `${rule.source}:${rule.ruleBehavior}`
    const group = groups.get(key) ?? (ruleListUpdate(type, rule.source, rule.ruleBehavior, []) as RuleListUpdate)
    group.rules.push(rule.ruleValue)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export async function hasPermissionsToUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<PermissionDecision> {
  const { decision, engineTrace, wrapper } = await decideToolPermissionWithModes(tool, input, context, assistantMessage, toolUseID)
  logForDebugging(`permission decision for ${tool.name}: ${decision.behavior} — ${JSON.stringify({ engine: engineTrace, wrapper })}`)
  return decision
}

export async function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  return (await decideRuleBasedPermissions(tool, input, context)).decision
}

export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: {
  rule: PermissionRule
  initialContext: ToolPermissionContext
  setToolPermissionContext: (context: ToolPermissionContext) => void
}): Promise<void> {
  if (READ_ONLY_SOURCES.has(rule.source)) throw new Error('Rules from read-only settings cannot be deleted.')
  const removal = ruleListUpdate('removeRules', rule.source, rule.ruleBehavior, [rule.ruleValue])
  const updated = applyPermissionUpdate(initialContext, removal)
  if (DISK_SOURCES.includes(rule.source)) deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
  setToolPermissionContext(updated)
}

export function applyPermissionRulesToPermissionContext(context: ToolPermissionContext, rules: PermissionRule[]): ToolPermissionContext {
  return applyPermissionUpdates(context, groupedBySourceAndBehavior(rules, 'addRules'))
}

export function syncPermissionRulesFromDisk(context: ToolPermissionContext, rules: PermissionRule[]): ToolPermissionContext {
  const cleared = [...(shouldAllowManagedPermissionRulesOnly() ? clearingOf(SESSION_SOURCES) : []), ...clearingOf(DISK_SOURCES)]
  return applyPermissionUpdates(context, [...cleared, ...groupedBySourceAndBehavior(rules, 'replaceRules')])
}
