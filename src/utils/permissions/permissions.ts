import { logForDebugging } from '../debug.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionRule,
  } from '../../types/permissions.js'
import { decideRuleBasedPermissions } from './decision/engine.js'
import { guardHookUpdatedInput, decideToolPermissionWithModes } from './decision/wrapper.js'
import {
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
import { createPermissionRequestMessage } from './decision/requestMessage.js'
import {
  addPermissionRulesToSettings,
  deletePermissionRuleFromSettings,
  shouldAllowManagedPermissionRulesOnly,
  type PermissionRuleFromEditableSettings,
} from './permissionsLoader.js'
import { applyPermissionUpdate } from './PermissionUpdate.js'

export {
  createPermissionRequestMessage,
  filterDeniedAgents,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForTool,
  getRuleByContentsForToolName,
  guardHookUpdatedInput,
  permissionRuleSourceDisplayString,
  toolAlwaysAllowedRule,
}

export async function hasPermissionsToUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<PermissionDecision> {
  const outcome = await decideToolPermissionWithModes(tool, input, context, assistantMessage, toolUseID)
  logForDebugging(
    `permission decision for ${tool.name}: ${outcome.decision.behavior} — ${JSON.stringify({ engine: outcome.engineTrace, wrapper: outcome.wrapper })}`,
  )
  return outcome.decision
}

export async function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const outcome = await decideRuleBasedPermissions(tool, input, context)
  return outcome.decision
}

type SetToolPermissionContext = (context: ToolPermissionContext) => void

export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: {
  rule: PermissionRule
  initialContext: ToolPermissionContext
  setToolPermissionContext: SetToolPermissionContext
}): Promise<void> {
  if (rule.source === 'policySettings' || rule.source === 'flagSettings' || rule.source === 'command') {
    throw new Error('Rules from read-only settings cannot be deleted.')
  }

  const updated = applyPermissionUpdate(initialContext, {
    type: 'removeRules',
    rules: [rule.ruleValue],
    behavior: rule.ruleBehavior,
    destination: rule.source,
  } as never)

  if (rule.source === 'userSettings' || rule.source === 'projectSettings' || rule.source === 'localSettings') {
    deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
  }

  setToolPermissionContext(updated)
}

export function applyPermissionRulesToPermissionContext(
  context: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  return foldGroupedRules(context, rules, 'addRules')
}

export function syncPermissionRulesFromDisk(
  context: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let next = context
  const managedOnly = shouldAllowManagedPermissionRulesOnly()

  const behaviors: PermissionBehavior[] = ['allow', 'deny', 'ask']
  const nonPolicySources = ['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session']
  const diskSources = ['userSettings', 'projectSettings', 'localSettings']

  if (managedOnly) {
    for (const source of nonPolicySources) {
      for (const behavior of behaviors) {
        next = applyPermissionUpdate(next, {
          type: 'replaceRules',
          rules: [],
          behavior,
          destination: source,
        } as never)
      }
    }
  }
  for (const source of diskSources) {
    for (const behavior of behaviors) {
      next = applyPermissionUpdate(next, {
        type: 'replaceRules',
        rules: [],
        behavior,
        destination: source,
      } as never)
    }
  }

  return foldGroupedRules(next, rules, 'replaceRules')
}

function foldGroupedRules(
  context: ToolPermissionContext,
  rules: PermissionRule[],
  updateType: 'addRules' | 'replaceRules',
): ToolPermissionContext {
  const groups = new Map<string, { source: string; behavior: PermissionBehavior; values: PermissionRule['ruleValue'][] }>()
  for (const rule of rules) {
    const key = `${rule.source}:${rule.ruleBehavior}`
    let group = groups.get(key)
    if (!group) {
      group = { source: rule.source, behavior: rule.ruleBehavior, values: [] }
      groups.set(key, group)
    }
    group.values.push(rule.ruleValue)
  }
  let next = context
  for (const group of groups.values()) {
    next = applyPermissionUpdate(next, {
      type: updateType,
      rules: group.values,
      behavior: group.behavior,
      destination: group.source,
    } as never)
  }
  return next
}

export { addPermissionRulesToSettings }
