/**
 * Rule accessors for the owned permission decision engine: the one place
 * that turns ToolPermissionContext's raw rule strings into typed
 * PermissionRule values and answers "which rule covers this tool?".
 * Pure functions — no io, no store reads. permissions.ts re-exports every
 * public name here as the frozen compatibility surface, so exported names
 * and signatures hold still.
 */
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
  // Runtime-derived rule sources (not persisted to settings): deny/allow/ask
  // rules synthesized from the active tools-narrowing set and from MCP server
  // policy/trust gating. Scanning them here is what makes getDeny/Ask/AllowRules
  // honor those rules.
  'toolsNarrowing',
  'mcpServerPolicy',
] as const satisfies readonly PermissionRuleSource[]

export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return getSettingSourceDisplayNameLowercase(source)
}

/** The context slice that stores rules of the given behavior — the
 *  context's own readonly view; the builder below never mutates it. */
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

/**
 * Parse every stored rule string of one behavior into a typed
 * PermissionRule, walking all recognized sources. The three public getters
 * below are this builder pinned to a behavior — one parse path, three
 * frozen names.
 */
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

/**
 * Does this rule cover the tool as a whole?
 *
 * Content-free rules only: `Bash` covers BashTool, `Bash(npm:*)` never does
 * (content-scoped rules are matched by the tool's own analyzer, not here).
 * An MCP rule may cover a whole server — `mcp__srv` and `mcp__srv__*` both
 * cover every `mcp__srv__<tool>`.
 */
function toolMatchesRule(
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
  rule: PermissionRule,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  // Matching identity for MCP tools is always the fully-qualified
  // mcp__server__tool spelling. That matters under skip-prefix mode
  // (MERCURY_SDK_MCP_NO_PREFIX), where an MCP tool can WEAR a builtin's
  // display name — a rule the operator wrote for the builtin must not
  // silently govern its MCP stand-in.
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)

  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  // Server-wide MCP coverage: the rule names a server (bare or `__*`) and the
  // tool lives under that server.
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

/** The whole-tool allow rule covering this tool, if any (content-free match only). */
export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return (
    getAllowRules(context).find(rule => toolMatchesRule(tool, rule)) || null
  )
}

/** The whole-tool deny rule covering this tool, if any. */
export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getDenyRules(context).find(rule => toolMatchesRule(tool, rule)) || null
}

/** The whole-tool ask rule covering this tool, if any. */
export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAskRules(context).find(rule => toolMatchesRule(tool, rule)) || null
}

/**
 * The deny rule pinning one agent type, if any: `Agent(Explore)` denies the
 * Explore agent while leaving the Agent tool itself alone.
 */
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

/** Drop every agent whose type a `Agent(type)` deny rule pins. */
export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  // One parse pass builds the denied-type set, then filtering is set
  // lookups. The per-agent getDenyRuleForAgent shape this replaced
  // re-parsed the whole deny list for every agent — agents×rules parses
  // for what one walk answers.
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

/**
 * Content-scoped rules for one tool, keyed by their content — e.g. the key
 * `npm:*` maps to the rule parsed from `Bash(npm:*)`. Whole-tool rules
 * (no content) never appear here; toolMatchesRule owns those.
 */
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

/**
 * Name-keyed variant of getRuleByContentsForTool, for tools that must reach
 * the rule table without importing the registry (cycle break).
 */
export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  // rulesForBehavior stamps every rule with the requested behavior, so the
  // only filters left are the tool's name and content-scopedness.
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
