import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PermissionAskDecision, PermissionDenyDecision, PermissionDecision,
  PermissionRule, PermissionRuleSource, PermissionUpdate,
} from '../../types/permissions.js'
import { logForDebugging } from '../debug.js'
import { applyPermissionUpdate, applyPermissionUpdates } from './PermissionUpdate.js'
import { decideRuleBasedPermissions } from './decision/engine.js'
import { decideToolPermissionWithModes } from './decision/wrapper.js'
import {
  deletePermissionRuleFromSettings, shouldAllowManagedPermissionRulesOnly,
  type PermissionRuleFromEditableSettings,
} from './permissionsLoader.js'

const diskRuleSources = ['userSettings', 'projectSettings', 'localSettings'] as const
const deletionPolicy: Partial<Record<PermissionRuleSource, 'disk' | 'locked'>> = {
  userSettings: 'disk',
  projectSettings: 'disk',
  localSettings: 'disk',
  policySettings: 'locked',
  flagSettings: 'locked',
  command: 'locked',
}

type RuleChange = Extract<PermissionUpdate, { rules: unknown }>

function collectRuleChanges(rules: PermissionRule[], type: RuleChange['type']): PermissionUpdate[] {
  const batches = Map.groupBy(rules, rule => `${rule.source}:${rule.ruleBehavior}`)
  return Array.from(batches.values(), group => ({
    type,
    rules: group.map(rule => rule.ruleValue),
    behavior: group[0]!.ruleBehavior,
    destination: group[0]!.source,
  } as PermissionUpdate))
}

function* emptyRuleSources(sources: readonly PermissionRuleSource[]): Generator<PermissionUpdate> {
  for (const destination of sources) {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      yield { type: 'replaceRules', rules: [], behavior, destination } as PermissionUpdate
    }
  }
}

export function applyPermissionRulesToPermissionContext(context: ToolPermissionContext, rules: PermissionRule[]): ToolPermissionContext {
  const changes = collectRuleChanges(rules, 'addRules')
  return applyPermissionUpdates(context, changes)
}

export function syncPermissionRulesFromDisk(context: ToolPermissionContext, rules: PermissionRule[]): ToolPermissionContext {
  const resets = shouldAllowManagedPermissionRulesOnly()
    ? [...diskRuleSources, 'cliArg', 'session', ...diskRuleSources] as const
    : diskRuleSources
  const changes = [...emptyRuleSources(resets), ...collectRuleChanges(rules, 'replaceRules')]
  return applyPermissionUpdates(context, changes)
}

export async function deletePermissionRule({ rule, initialContext, setToolPermissionContext }: {
  rule: PermissionRule
  initialContext: ToolPermissionContext
  setToolPermissionContext: (context: ToolPermissionContext) => void
}): Promise<void> {
  const policy = deletionPolicy[rule.source]
  if (policy === 'locked') throw new Error('Rules from read-only settings cannot be deleted.')
  const context = applyPermissionUpdate(initialContext, {
    type: 'removeRules', rules: [rule.ruleValue], behavior: rule.ruleBehavior, destination: rule.source,
  } as PermissionUpdate)
  if (policy === 'disk') deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
  setToolPermissionContext(context)
}

function reportedDecision(tool: Tool, result: Awaited<ReturnType<typeof decideToolPermissionWithModes>>): PermissionDecision {
  const trace = { engine: result.engineTrace, wrapper: result.wrapper }
  logForDebugging(`permission decision for ${tool.name}: ${result.decision.behavior} — ${JSON.stringify(trace)}`)
  return result.decision
}

export async function hasPermissionsToUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<PermissionDecision> {
  const result = await decideToolPermissionWithModes(tool, input, context, assistantMessage, toolUseID)
  return reportedDecision(tool, result)
}

export async function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const result = await decideRuleBasedPermissions(tool, input, context)
  return result.decision
}

export { addPermissionRulesToSettings } from './permissionsLoader.js'
export { createPermissionRequestMessage } from './decision/requestMessage.js'
export { guardHookUpdatedInput } from './decision/wrapper.js'
export {
  getAllowRules, getAskRules, getDenyRules,
  getAskRuleForTool, getDenyRuleForTool, toolAlwaysAllowedRule,
  filterDeniedAgents, getDenyRuleForAgent,
  getRuleByContentsForTool, getRuleByContentsForToolName, permissionRuleSourceDisplayString,
} from './decision/rules.js'
