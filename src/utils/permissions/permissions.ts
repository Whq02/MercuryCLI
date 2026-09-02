/**
 * Compatibility surface for the permission entry point plus rule add / sync /
 * delete helpers. The ordered decision engine itself lives in the sibling
 * decision directory and is out of this slice; this module re-exports its
 * accessors and adapts its entry path.
 */
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

// Pass-through re-exports.
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

/**
 * The permission entry function. Delegates to the mode-wrapper decision path,
 * logs the full decision trace for debugging, and returns the decision.
 */
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

/**
 * The rule-subset check: only the rule-based stages (everything before the
 * mode band). Returns a deny/ask decision or null; runs no classifier, mode
 * transforms, hooks, or bypass checks.
 */
export async function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const outcome = await decideRuleBasedPermissions(tool, input, context)
  return outcome.decision
}

type SetToolPermissionContext = (context: ToolPermissionContext) => void

/**
 * Delete a permission rule. Throws for read-only sources; applies a
 * removeRules update to the context, deletes from disk for the three editable
 * settings sources, and pushes the updated context to the setter — including
 * when the disk delete failed.
 */
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
    // Ignore the disk call's success flag; the in-memory update stands.
    deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
  }
  // cliArg/session and the runtime-derived sources (toolsNarrowing,
  // mcpServerPolicy) need no disk action.

  setToolPermissionContext(updated)
}

/** Group rules by source:behavior and apply addRules updates. */
export function applyPermissionRulesToPermissionContext(
  context: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  return foldGroupedRules(context, rules, 'addRules')
}

/**
 * Sync rules from disk (replacement): clear the relevant sources, then apply
 * replaceRules updates grouped by source:behavior.
 */
export function syncPermissionRulesFromDisk(
  context: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let next = context
  const managedOnly = shouldAllowManagedPermissionRulesOnly()

  const behaviors: PermissionBehavior[] = ['allow', 'deny', 'ask']
  const nonPolicySources = ['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session']
  const diskSources = ['userSettings', 'projectSettings', 'localSettings']

  // 1. Under managed-rules-only, clear all non-policy sources across behaviours.
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
  // 2. Always clear the three disk sources across behaviours.
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

/** Group rules by (source, behaviour) and apply add/replace updates. */
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

// addPermissionRulesToSettings is part of this module's compatibility surface.
export { addPermissionRulesToSettings }
