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
import { RULE_INHERITS } from '../../../constants/tools.js'

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

type RuleTableShape = {
  rows: PermissionRule[]
  byBehavior: Record<PermissionBehavior, PermissionRule[]>
  contentScoped: Map<string, PermissionRule[]>
}

const emptyTable = (): RuleTableShape => ({
  rows: [],
  byBehavior: { allow: [], deny: [], ask: [] },
  contentScoped: new Map(),
})

function buildRuleTable(context: ToolPermissionContext): RuleTableShape {
  const table = emptyTable()
  for (const behavior of ['allow', 'deny', 'ask'] as const) {
    const bySource = ruleStringsByBehavior(context, behavior) ?? {}
    for (const source of PERMISSION_RULE_SOURCES) {
      for (const ruleString of bySource[source] ?? []) {
        const row: PermissionRule = {
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        }
        table.rows.push(row)
        table.byBehavior[behavior].push(row)
        if (row.ruleValue.ruleContent !== undefined) {
          const key = `${row.ruleValue.toolName}\0${row.ruleValue.ruleContent}`
          const bucket = table.contentScoped.get(key)
          if (bucket) bucket.push(row)
          else table.contentScoped.set(key, [row])
        }
      }
    }
  }
  return table
}

const tableCache = new WeakMap<ToolPermissionContext, { signature: string; table: RuleTableShape }>()

function ruleTable(context: ToolPermissionContext): RuleTableShape {
  const signature = JSON.stringify([
    context.alwaysAllowRules,
    context.alwaysDenyRules,
    context.alwaysAskRules,
  ])
  const cached = tableCache.get(context)
  if (cached?.signature === signature) return cached.table
  const table = buildRuleTable(context)
  tableCache.set(context, { signature, table })
  return table
}

function copyRule(rule: PermissionRule): PermissionRule {
  return { ...rule, ruleValue: { ...rule.ruleValue } }
}

function copyMatch(rule: PermissionRule | undefined): PermissionRule | null {
  return rule === undefined ? null : copyRule(rule)
}

export function getAllowRules(
  context: ToolPermissionContext,
): PermissionRule[] {
  return ruleTable(context).byBehavior.allow.map(copyRule)
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return ruleTable(context).byBehavior.deny.map(copyRule)
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return ruleTable(context).byBehavior.ask.map(copyRule)
}

function toolMatchesRule(
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
  rule: PermissionRule,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  const nameForRuleMatch = getToolNameForPermissionCheck(tool)

  if (rule.ruleValue.toolName === nameForRuleMatch || RULE_INHERITS[nameForRuleMatch]?.includes(rule.ruleValue.toolName)) {
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
  return copyMatch(ruleTable(context).byBehavior.allow.find(rule => toolMatchesRule(tool, rule)))
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return copyMatch(ruleTable(context).byBehavior.deny.find(rule => toolMatchesRule(tool, rule)))
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return copyMatch(ruleTable(context).byBehavior.ask.find(rule => toolMatchesRule(tool, rule)))
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  const key = `${agentToolName}\0${agentType}`
  return copyMatch(ruleTable(context).contentScoped.get(key)?.find(rule => rule.ruleBehavior === 'deny'))
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  const deniedAgentTypes = new Set<string>()
  for (const rule of ruleTable(context).byBehavior.deny) {
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
  for (const rule of ruleTable(context).byBehavior[behavior]) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, copyRule(rule))
    }
  }
  return ruleByContents
}

export function permissionRuleTable(context: ToolPermissionContext): readonly PermissionRule[] {
  return ruleTable(context).rows.map(copyRule)
}
