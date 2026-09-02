import type { QuerySource } from '../../constants/querySource.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Tools } from '../../Tool.js'
import { harnessContextPolicyRequest } from '../../services/mission/harnessApplication.js'
import type { EffortValue } from '../../utils/effort.js'
import {
  buildRequestContextPlan,
  type RequestContextPlan,
} from '../../services/run/requestContextPlan.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js'
import { getSourceDisplayName } from '../../utils/settings/constants.js'
import { formatTokens } from '../../utils/format.js'

const DEFAULT_QUERY_SOURCE: QuerySource = 'repl_main_thread'

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
  mainLoopModel: string
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
      contentReplacementState: params.contentReplacementState,
      skipToolNames: skipToolNamesFor(params.tools),
      harnessContextPolicy: harnessContextPolicyRequest(params.mainLoopModel, params.effortValue),
    },
    'inspect',
  )
}

export type CollectContextDataInput = {
  messages: Message[]
  getAppState: () => AppState
  contentReplacementState?: ContentReplacementState
  agentId?: string
  owner?: OwnerKey
  options: {
    mainLoopModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
  }
}

export async function collectContextData(input: CollectContextDataInput): Promise<ContextData> {
  const { options } = input
  const owner = input.owner ?? processMainOwner()
  const plan = await buildContextInspectionPlan({
    messages: input.messages,
    owner,
    mainLoopModel: options.mainLoopModel,
    effortValue: input.getAppState().effortValue,
    tools: options.tools,
    contentReplacementState: input.contentReplacementState,
    querySource: options.querySource,
  })
  const syntheticCarrier = {
    options: {
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
    options.mainLoopModel,
    async () => input.getAppState().toolPermissionContext,
    options.tools,
    options.agentDefinitions,
    undefined,
    syntheticCarrier,
    undefined,
    plan.messages,
  )
}

function agentSourceWord(source: string): string {
  switch (source) {
    case 'projectSettings':
      return 'Project'
    case 'userSettings':
      return 'User'
    case 'localSettings':
      return 'Local'
    case 'flagSettings':
      return 'Flag'
    case 'policySettings':
      return 'Policy'
    case 'extension':
      return 'Extension'
    case 'built-in':
      return 'Built-in'
    default:
      return String(source)
  }
}

export function renderContextUsageMarkdown(data: ContextData): string {
  const lines: string[] = []
  lines.push('## Context Usage')
  lines.push('')
  lines.push(`**Model:** ${data.model}  `)
  lines.push(
    `**Tokens:** ${formatTokens(data.totalTokens)} / ${formatTokens(data.rawMaxTokens)} (${data.percentage}%)`,
  )
  lines.push('')

  const qualifying = data.categories.filter(
    category =>
      category.tokens > 0 &&
      category.name !== FREE_SPACE_CATEGORY &&
      category.name !== AUTOCOMPACT_BUFFER_CATEGORY,
  )
  if (qualifying.length > 0) {
    lines.push('### Estimated usage by category')
    lines.push('')
    lines.push('| Category | Tokens | Percentage |')
    lines.push('| --- | --- | --- |')
    const percentOf = (tokens: number): string =>
      `${((tokens / data.rawMaxTokens) * 100).toFixed(1)}%`
    for (const category of qualifying) {
      lines.push(`| ${category.name} | ${formatTokens(category.tokens)} | ${percentOf(category.tokens)} |`)
    }
    for (const name of [FREE_SPACE_CATEGORY, AUTOCOMPACT_BUFFER_CATEGORY]) {
      const category = data.categories.find(c => c.name === name)
      if (category && category.tokens > 0) {
        lines.push(`| ${category.name} | ${formatTokens(category.tokens)} | ${percentOf(category.tokens)} |`)
      }
    }
    lines.push('')
  }

  if (data.mcpTools.length > 0) {
    lines.push('### MCP Tools')
    lines.push('')
    lines.push('| Tool | Server | Tokens |')
    lines.push('| --- | --- | --- |')
    for (const tool of data.mcpTools) {
      lines.push(`| ${tool.name} | ${tool.serverName} | ${formatTokens(tool.tokens)} |`)
    }
    lines.push('')
  }

  if (data.agents.length > 0) {
    lines.push('### Custom Agents')
    lines.push('')
    lines.push('| Agent Type | Source | Tokens |')
    lines.push('| --- | --- | --- |')
    for (const agent of data.agents) {
      lines.push(`| ${agent.agentType} | ${agentSourceWord(agent.source)} | ${formatTokens(agent.tokens)} |`)
    }
    lines.push('')
  }

  if (data.memoryFiles.length > 0) {
    lines.push('### Memory Files')
    lines.push('')
    lines.push('| Type | Path | Tokens |')
    lines.push('| --- | --- | --- |')
    for (const file of data.memoryFiles) {
      lines.push(`| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |`)
    }
    lines.push('')
  }

  const skills = data.skills
  if (skills && skills.tokens > 0 && skills.skillFrontmatter.length > 0) {
    lines.push('### Skills')
    lines.push('')
    lines.push('| Skill | Source | Tokens |')
    lines.push('| --- | --- | --- |')
    for (const skill of skills.skillFrontmatter) {
      lines.push(`| ${skill.name} | ${getSourceDisplayName(skill.source)} | ${formatTokens(skill.tokens)} |`)
    }
    if (skills.listingTruncation && (skills.listingTruncation.nameOnly > 0 || skills.listingTruncation.withheld > 0)) {
      lines.push('')
      lines.push(
        `Skill listing degraded by its budget: ${skills.listingTruncation.nameOnly} entries name-only${skills.listingTruncation.withheld > 0 ? `, ${skills.listingTruncation.withheld} name(s) withheld` : ''}.`,
      )
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const data = await collectContextData({
    messages: context.messages,
    getAppState: context.getAppState,
    contentReplacementState: context.contentReplacementState,
    agentId: context.agentId,
    ...(context.owner !== undefined ? { owner: context.owner } : {}),
    options: {
      mainLoopModel: context.options.mainLoopModel,
      tools: context.options.tools,
      agentDefinitions: {
        activeAgents: context.options.agentDefinitions.activeAgents,
        allAgents:
          context.options.agentDefinitions.allAgents ??
          context.options.agentDefinitions.activeAgents,
      },
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
  return { type: 'text', value: renderContextUsageMarkdown(data) }
}
