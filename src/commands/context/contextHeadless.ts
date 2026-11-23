import type { QuerySource } from '../../engine/requests/querySource.js'
import type { AppState } from '../../screen/app-state/AppState.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { EffortValue } from '../../models/effort/effort.js'
import {
  buildRequestContextPlan,
  type RequestContextPlan,
} from '../../engine/run/requestContextPlan.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import type { ContentReplacementState } from '../../engine/tool-dispatch/toolResultStorage.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../engine/context-window/analyzeContext.js'
import { getSourceDisplayName } from '../../platform/settings/settingSources.js'
import { formatTokens } from '../../platform/text/format.js'

const DEFAULT_QUERY_SOURCE: QuerySource = 'main_thread'

const FREE_SPACE_CATEGORY = 'Free space'
const AUTOCOMPACT_BUFFER_CATEGORY = 'Autocompact buffer'

function skipToolNamesFor(tools: Tools): ReadonlySet<string> {
  return new Set(
    tools.filter(tool => !Number.isFinite(tool.maxResultSizeChars)).map(tool => tool.name),
  )
}

export async function buildContextInspectionPlan(params: {
  messages: Message[]
  owner: OwnerKey
  engineModel: string
  effortValue?: EffortValue
  tools: Tools
  contentReplacementState: ContentReplacementState | undefined
  querySource?: QuerySource
}): Promise<RequestContextPlan> {
  return buildRequestContextPlan(
    {
      messages: params.messages,
      owner: params.owner,
      querySource: params.querySource ?? DEFAULT_QUERY_SOURCE,
      engineModel: params.engineModel,
      contentReplacementState: params.contentReplacementState,
      skipToolNames: skipToolNamesFor(params.tools),
      harnessContextPolicy: null,
      preserveBodies: true,
    },
    'inspect',
  )
}

export type CollectContextDataInput = {
  messages: Message[]
  owner?: OwnerKey
  agentId?: string
  getAppState: () => Pick<AppState, 'effortValue' | 'toolPermissionContext'>
  contentReplacementState?: ContentReplacementState
  options: {
    engineModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    querySource?: QuerySource
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
}

export async function collectContextData(input: CollectContextDataInput): Promise<ContextData> {
  const { options } = input
  const owner = input.owner ?? processMainOwner()
  const plan = await buildContextInspectionPlan({
    messages: input.messages,
    owner,
    engineModel: options.engineModel,
    effortValue: input.getAppState().effortValue,
    tools: options.tools,
    contentReplacementState: input.contentReplacementState,
    querySource: options.querySource,
  })
  const syntheticCarrier = {
    options: {
      isNonInteractiveSession: true,
      ...(options.customSystemPrompt !== undefined
        ? { customSystemPrompt: options.customSystemPrompt }
        : {}),
      ...(options.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: options.appendSystemPrompt }
        : {}),
    },
  } as Pick<ToolUseContext, 'options'>
  return analyzeContextUsage(
    plan.messages,
    options.engineModel,
    async () => input.getAppState().toolPermissionContext,
    options.tools,
    options.agentDefinitions,
    undefined,
    syntheticCarrier,
    undefined,
    plan.messages,
  )
}

const AGENT_SOURCE_LABELS: Record<string, string> = {
  projectSettings: 'Project',
  userSettings: 'User',
  localSettings: 'Local',
  flagSettings: 'Flag',
  policySettings: 'Policy',
  extension: 'Extension',
  'built-in': 'Built-in',
}

function formatSkillSource(source: string): string {
  switch (source) {
    case 'userSettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
    case 'policySettings':
    case 'extension':
    case 'built-in':
      return getSourceDisplayName(source)
    default:
      return source
  }
}

export function renderContextUsageMarkdown(data: ContextData): string {
  const lines: string[] = [
    '## Context Usage',
    '',
    `**Model:** ${data.model}`,
    `**Tokens:** ${formatTokens(data.totalTokens)} / ${formatTokens(data.rawMaxTokens)} (${data.percentage}%)`,
  ]

  const pctOf = (tokens: number): string =>
    data.rawMaxTokens > 0 ? `${((tokens / data.rawMaxTokens) * 100).toFixed(1)}%` : '0.0%'

  const ordinaryCategories = data.categories.filter(
    cat => cat.name !== FREE_SPACE_CATEGORY && cat.name !== AUTOCOMPACT_BUFFER_CATEGORY && cat.tokens > 0,
  )
  const freeSpace = data.categories.find(cat => cat.name === FREE_SPACE_CATEGORY && cat.tokens > 0)
  const autocompactBuffer = data.categories.find(
    cat => cat.name === AUTOCOMPACT_BUFFER_CATEGORY && cat.tokens > 0,
  )

  if (ordinaryCategories.length > 0) {
    lines.push(
      '',
      '### Estimated usage by category',
      '',
      '| Category | Tokens | Percentage |',
      '|----------|--------|------------|',
    )
    for (const cat of ordinaryCategories) {
      lines.push(`| ${cat.name} | ${formatTokens(cat.tokens)} | ${pctOf(cat.tokens)} |`)
    }
    if (freeSpace) {
      lines.push(`| ${freeSpace.name} | ${formatTokens(freeSpace.tokens)} | ${pctOf(freeSpace.tokens)} |`)
    }
    if (autocompactBuffer) {
      lines.push(
        `| ${autocompactBuffer.name} | ${formatTokens(autocompactBuffer.tokens)} | ${pctOf(autocompactBuffer.tokens)} |`,
      )
    }
  }

  if (data.mcpTools.length > 0) {
    lines.push('', '### MCP Tools', '', '| Tool | Server | Tokens |', '|------|--------|--------|')
    for (const tool of data.mcpTools) {
      lines.push(`| ${tool.name} | ${tool.serverName} | ${formatTokens(tool.tokens)} |`)
    }
  }

  if (data.agents.length > 0) {
    lines.push('', '### Custom Agents', '', '| Agent Type | Source | Tokens |', '|------------|--------|--------|')
    for (const agent of data.agents) {
      const sourceLabel = AGENT_SOURCE_LABELS[agent.source] ?? agent.source
      lines.push(`| ${agent.agentType} | ${sourceLabel} | ${formatTokens(agent.tokens)} |`)
    }
  }

  if (data.memoryFiles.length > 0) {
    lines.push('', '### Memory Files', '', '| Type | Path | Tokens |', '|------|------|--------|')
    for (const file of data.memoryFiles) {
      lines.push(`| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |`)
    }
  }

  if (data.skills && data.skills.tokens > 0 && data.skills.skillFrontmatter.length > 0) {
    lines.push('', '### Skills', '', '| Skill | Source | Tokens |', '|-------|--------|--------|')
    for (const skill of data.skills.skillFrontmatter) {
      lines.push(`| ${skill.name} | ${formatSkillSource(skill.source)} | ${formatTokens(skill.tokens)} |`)
    }
    const trunc = data.skills.listingTruncation
    if (trunc && (trunc.nameOnly > 0 || trunc.withheld > 0)) {
      const parts: string[] = []
      if (trunc.nameOnly > 0) parts.push(`${trunc.nameOnly} entries name-only`)
      if (trunc.withheld > 0) parts.push(`${trunc.withheld} name(s) withheld`)
      lines.push('', `Skill listing degraded by its budget: ${parts.join(', ')}`)
    }
  }

  return lines.join('\n').trimEnd()
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const rawDefs = context.options.agentDefinitions
  const agentDefinitions: AgentDefinitionsResult = {
    activeAgents: rawDefs.activeAgents,
    allAgents: Array.isArray(rawDefs.allAgents) ? rawDefs.allAgents : rawDefs.activeAgents,
    ...(rawDefs.allowedAgentTypes !== undefined
      ? { allowedAgentTypes: rawDefs.allowedAgentTypes }
      : {}),
  }
  const data = await collectContextData({
    messages: context.messages,
    getAppState: context.getAppState,
    contentReplacementState: context.contentReplacementState,
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    ...(context.owner !== undefined ? { owner: context.owner } : {}),
    options: {
      engineModel: context.options.engineModel,
      tools: context.options.tools,
      agentDefinitions,
      ...(context.options.customSystemPrompt !== undefined
        ? { customSystemPrompt: context.options.customSystemPrompt }
        : {}),
      ...(context.options.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: context.options.appendSystemPrompt }
        : {}),
      ...(context.options.querySource !== undefined
        ? { querySource: context.options.querySource }
        : {}),
    },
  })
  return {
    type: 'text',
    value: renderContextUsageMarkdown(data),
  }
}
