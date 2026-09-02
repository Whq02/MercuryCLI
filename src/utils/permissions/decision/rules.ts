import {
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from '../../../services/mcp/mcpStringUtils.js'
import type { Tool, ToolPermissionContext } from '../../../Tool.js'
import {
  getSettingSourceDisplayNameLowercase,
  SETTING_SOURCES,
} from '../../settings/constants.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
} from '../PermissionRule.js'
import { permissionRuleValueFromString } from '../permissionRuleParser.js'

const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  'cliArg',
  'command',
  'session',
  'toolsNarrowing',
  'mcpServerPolicy',
] as const satisfies readonly PermissionRuleSource[]

export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return getSettingSourceDisplayNameLowercase(source)
}

function ruleStringsByBehavior(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): ToolPermissionContext['alwaysAllowRules'] {
  switch (behavior) {
    case 'allow':
      return context.alwaysAllowRules
    case 'deny':
      return context.alwaysDenyRules
    case 'ask':
      return context.alwaysAskRules
  }
}

function rulesForBehavior(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const bySource = ruleStringsByBehavior(context, behavior)
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (bySource[source] ?? []).map(ruleString => ({
      source,
      ruleBehavior: behavior,
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getAllowRules(
  context: ToolPermissionContext,
): PermissionRule[] {
  return rulesForBehavior(context, 'allow')
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return rulesForBehavior(context, 'deny')
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return rulesForBehavior(context, 'ask')
}

function toolMatchesRule(
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
  rule: PermissionRule,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  const nameForRuleMatch = getToolNameForPermissionCheck(tool)

  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return (
    getAllowRules(context).find(rule => toolMatchesRule(tool, rule)) || null
  )
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getDenyRules(context).find(rule => toolMatchesRule(tool, rule)) || null
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAskRules(context).find(rule => toolMatchesRule(tool, rule)) || null
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return (
    getDenyRules(context).find(
      rule =>
        rule.ruleValue.toolName === agentToolName &&
        rule.ruleValue.ruleContent === agentType,
    ) || null
  )
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  const deniedAgentTypes = new Set<string>()
  for (const rule of getDenyRules(context)) {
    if (
      rule.ruleValue.toolName === agentToolName &&
      rule.ruleValue.ruleContent !== undefined
    ) {
      deniedAgentTypes.add(rule.ruleValue.ruleContent)
    }
  }
  return agents.filter(agent => !deniedAgentTypes.has(agent.agentType))
}

export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(
    context,
    getToolNameForPermissionCheck(tool),
    behavior,
  )
}

export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  for (const rule of rulesForBehavior(context, behavior)) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}
