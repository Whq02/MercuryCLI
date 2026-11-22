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
import { notBuilt } from '../../../pi/holes.js'

export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return notBuilt('src/utils/permissions/decision/rules.ts:31')
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
  return notBuilt('src/utils/permissions/decision/rules.ts:61')
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
  return notBuilt('src/utils/permissions/decision/rules.ts:108')
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return notBuilt('src/utils/permissions/decision/rules.ts:114')
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return notBuilt('src/utils/permissions/decision/rules.ts:118')
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

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return notBuilt('src/utils/permissions/decision/rules.ts:159')
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return notBuilt('src/utils/permissions/decision/rules.ts:166')
}

export function mcpServerPermissionTarget(serverName: string): {
  name: string
  mcpInfo: { serverName: string; toolName: string }
} {
  return notBuilt('src/utils/permissions/decision/rules.ts:173')
}

export function getDenyRuleForMcpServer(
  context: ToolPermissionContext,
  serverName: string,
): PermissionRule | null {
  return notBuilt('src/utils/permissions/decision/rules.ts:180')
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return notBuilt('src/utils/permissions/decision/rules.ts:187')
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return notBuilt('src/utils/permissions/decision/rules.ts:194')
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  return notBuilt('src/utils/permissions/decision/rules.ts:203')
}

export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return notBuilt('src/utils/permissions/decision/rules.ts:220')
}

export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return notBuilt('src/utils/permissions/decision/rules.ts:232')
}
