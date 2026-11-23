import {
  getMcpPrefix,
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from '../../mcp/mcpStringUtils.js'
import type { Tool, ToolPermissionContext } from '../../../Tool.js'
import { lspFamilyMatches } from '../../lsp/toolFamily.js'
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
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { MONITOR_TOOL_NAME } from '../../../constants/tools/monitor.js'

const ALL_RULE_SOURCES: readonly PermissionRuleSource[] = [
  ...SETTING_SOURCES,
  'cliArg',
  'command',
  'session',
  'toolsNarrowing',
  'mcpServerPolicy',
]

const BEHAVIOR_FIELDS: readonly [PermissionBehavior, 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules'][] = [
  ['allow', 'alwaysAllowRules'],
  ['deny', 'alwaysDenyRules'],
  ['ask', 'alwaysAskRules'],
]

function contentBucketKey(behavior: PermissionBehavior, toolName: string): string {
  return `${behavior}\0${toolName}`
}

export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return getSettingSourceDisplayNameLowercase(source)
}

type RuleTableShape = {
  byBehavior: Record<PermissionBehavior, PermissionRule[]>
  contentScoped: Map<string, PermissionRule[]>
}

const emptyTable = (): RuleTableShape => ({
  byBehavior: { allow: [], deny: [], ask: [] },
  contentScoped: new Map(),
})

function buildRuleTable(context: ToolPermissionContext): RuleTableShape {
  const table = emptyTable()
  for (const [behavior, field] of BEHAVIOR_FIELDS) {
    const bySource = context[field]
    if (!bySource) continue
    for (const source of ALL_RULE_SOURCES) {
      const entries = bySource[source]
      if (!entries) continue
      for (const raw of entries) {
        const ruleValue = permissionRuleValueFromString(raw)
        const rule: PermissionRule = { source, ruleBehavior: behavior, ruleValue }
        table.byBehavior[behavior].push(rule)
        if (ruleValue.ruleContent !== undefined) {
          const key = contentBucketKey(behavior, ruleValue.toolName)
          let bucket = table.contentScoped.get(key)
          if (bucket === undefined) {
            bucket = []
            table.contentScoped.set(key, bucket)
          }
          bucket.push(rule)
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

export function namesWholeServerOf(ruleToolName: string, toolName: string): boolean {
  const ruleTarget = mcpInfoFromString(ruleToolName)
  const toolTarget = mcpInfoFromString(toolName)
  if (ruleTarget === null || toolTarget === null) return false
  const serverWide = ruleTarget.toolName === undefined || ruleTarget.toolName === '*'
  return serverWide && ruleTarget.serverName === toolTarget.serverName
}

export function namesWholeServerOfTool(
  ruleToolName: string,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): boolean {
  if (tool.mcpInfo === undefined) return namesWholeServerOf(ruleToolName, getToolNameForPermissionCheck(tool))
  const prefix = getMcpPrefix(tool.mcpInfo.serverName)
  return ruleToolName === prefix.slice(0, -2) || ruleToolName === `${prefix}*`
}

export function runsItsCommandAsBash(toolName: string): boolean {
  return toolName === MONITOR_TOOL_NAME
}

function matchesWholeTool(
  rule: PermissionRule,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
  toolName: string,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) return false
  const ruleToolName = rule.ruleValue.toolName
  if (ruleToolName === toolName) return true
  if (RULE_INHERITS[toolName]?.includes(ruleToolName)) return true
  if (ruleToolName === BASH_TOOL_NAME && runsItsCommandAsBash(toolName)) return true
  if (lspFamilyMatches(ruleToolName, toolName)) return true
  return namesWholeServerOfTool(ruleToolName, tool)
}

function findWholeToolRule(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  const toolName = getToolNameForPermissionCheck(tool)
  const found = ruleTable(context).byBehavior[behavior].find(rule =>
    matchesWholeTool(rule, tool, toolName),
  )
  return copyMatch(found)
}

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return findWholeToolRule(context, 'allow', tool)
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return findWholeToolRule(context, 'deny', tool)
}

export function mcpServerPermissionTarget(serverName: string): {
  name: string
  mcpInfo: { serverName: string; toolName: string }
} {
  return {
    name: getMcpPrefix(serverName),
    mcpInfo: { serverName, toolName: '' },
  }
}

export function getDenyRuleForMcpServer(
  context: ToolPermissionContext,
  serverName: string,
): PermissionRule | null {
  return getDenyRuleForTool(context, mcpServerPermissionTarget(serverName))
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return findWholeToolRule(context, 'ask', tool)
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  const rules = ruleTable(context).contentScoped.get(contentBucketKey('deny', agentToolName))
  if (rules === undefined) return null
  const found = rules.find(rule => rule.ruleValue.ruleContent === agentType)
  return copyMatch(found)
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  const rules = ruleTable(context).contentScoped.get(contentBucketKey('deny', agentToolName))
  if (rules === undefined || rules.length === 0) return [...agents]
  const denied = new Set<string>()
  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
    if (content !== undefined) denied.add(content)
  }
  return agents.filter(agent => !denied.has(agent.agentType))
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
  const map = new Map<string, PermissionRule>()
  const rules = ruleTable(context).contentScoped.get(contentBucketKey(behavior, toolName))
  if (rules === undefined) return map
  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
    if (content !== undefined) map.set(content, copyRule(rule))
  }
  return map
}
