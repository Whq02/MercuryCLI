import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { buildTool, type Tool as ToolShape, type ToolDef, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getDenyRuleForAgent } from '../../utils/permissions/decision/rules.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../../utils/permissions/ruleReason.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { agentRosterOf, getPrompt, withoutAgentRoster } from './prompt.js'
import { swarmSessionEnabled } from '../../services/crewBoard/seam.js'
import * as UI from './UI.js'
import { isResultTruncated } from './UI.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { AgentDefinition } from '../../types/agent.js'
import type { AssistantMessage } from '../../types/message.js'
import { type Progress, type AgentToolInput, inputSchema, outputSchema, type AgentToolOutput } from './agent/schema.js'
import { agentCwdQuestion } from './agent/cwd.js'
import { mcpServerNamesWithTools, agentToolCall } from './agent/call.js'
import { agentToolResultBlock } from './agent/resultBlock.js'
export type { Progress, AgentToolInput, AgentToolOutput } from './agent/schema.js'
export { inputSchema, outputSchema } from './agent/schema.js'
export { resolveAgentCwd, agentCwdQuestion } from './agent/cwd.js'

const RESULT_SIZE_CAP = 100_000


type InputSchema = ReturnType<typeof inputSchema>
type OutputSchema = ReturnType<typeof outputSchema>

const AGENT_DESCRIPTION =
  'Delegate a task to a crewmate: a new crewmate that handles complex, multi-step work on its own'

const AGENT_WIRE_DESCRIPTION =
  'Launch an independent crewmate from a task brief and return its report. The child does not inherit this conversation; its session-owned processes end with it.'

export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  maxResultSizeChars: RESULT_SIZE_CAP,
  searchHint: 'delegate a bounded task to an independent agent and receive its report',
  searchKeywords: [
    'swarm',
    'agents',
    'seats',
    'team',
    'launch',
    'wave',
    'delegate',
    'crew',
    'subagent',
  ],
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return AGENT_DESCRIPTION
  },
  wireDescription(fullPrompt: string): string {
    const roster = agentRosterOf(fullPrompt)
    return roster ? `${AGENT_WIRE_DESCRIPTION}\n\n${roster}` : AGENT_WIRE_DESCRIPTION
  },
  manualText(fullPrompt: string): string {
    return withoutAgentRoster(fullPrompt)
  },
  async prompt({
    getToolPermissionContext,
    tools,
    agents,
    allowedAgentTypes,
  }: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: readonly ToolShape[]
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }) {
    const serverNames = mcpServerNamesWithTools(tools).map(name => name.toLowerCase())
    const eligible = agents.filter(agent => {
      const required = agent.requiredMcpServers
      if (!required || required.length === 0) return true
      return required.every(pattern => {
        const needle = pattern.toLowerCase()
        return serverNames.some(server => server.includes(needle))
      })
    })
    const permissionContext = await getToolPermissionContext()
    const refusals = new Map<string, string>()
    for (const agent of eligible) {
      const denyRule = getDenyRuleForAgent(permissionContext, AGENT_TOOL_NAME, agent.agentType)
      if (denyRule) {
        refusals.set(
          agent.agentType,
          refusalWithReason(
            ruleSentence('launching it', 'deny', denyRule),
            reasonForRule(permissionContext, denyRule),
          ),
        )
      }
    }
    const availableNames = new Set(tools.map(tool => tool.name))
    return getPrompt(
      eligible,
      false,
      allowedAgentTypes,
      availableNames,
      refusals,
      swarmSessionEnabled(),
    )
  },
  isEnabled() {
    return evaluateLaunchAuthority('subagents').allowed
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async checkPermissions(input: AgentToolInput, context: ToolUseContext) {
    if (input.cwd) {
      const decision = agentCwdQuestion(input.cwd, context.getAppState().toolPermissionContext)
      if (decision !== null) return decision
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  getActivityDescription(input?: Partial<AgentToolInput>) {
    return input?.description ?? 'Running task'
  },
  extractSearchText(output: AgentToolOutput): string {
    if (output.status === 'async_launched' || !Array.isArray(output.content)) return ''
    return output.content
      .map(block => block.text)
      .filter(text => text.length > 0)
      .join('\n')
  },
  userFacingName: UI.userFacingName,
  userFacingNameBackgroundColor: UI.userFacingNameBackgroundColor,
  renderToolUseTag: UI.renderToolUseTag,
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolUseProgressMessage: UI.renderToolUseProgressMessage,
  renderToolUseRejectedMessage: UI.renderToolUseRejectedMessage,
  renderToolUseErrorMessage: UI.renderToolUseErrorMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
  renderGroupedToolUse: UI.renderGroupedAgentToolUse,
  isResultTruncated,
  async call(
    input: AgentToolInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress,
  ) {
    return agentToolCall(input, context, canUseTool, parentAssistantMessage, onProgress)
  },
  mapToolResultToToolResultBlockParam(output: AgentToolOutput, toolUseID: string) {
    return agentToolResultBlock(output, toolUseID)
  },
} satisfies ToolDef<InputSchema, AgentToolOutput, Progress>)
