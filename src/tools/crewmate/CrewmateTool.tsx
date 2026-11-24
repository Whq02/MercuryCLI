import { evaluateLaunchAuthority } from '../../daemon/switchboard/launchAuthority.js'
import { buildTool, type Tool as ToolShape, type ToolDef, type ToolPermissionContext, type ToolUseContext } from '../kit/tool.js'
import { getDenyRuleForAgent } from '../../permissions/rules/decision/rules.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../../permissions/rules/ruleReason.js'
import { CREWMATE_TOOL_NAME } from '../kit/names/crewmate.js'
import { agentRosterOf, getPrompt, withoutAgentRoster } from './prompt.js'
import { swarmSessionEnabled } from '../../crew/board/seam.js'
import * as UI from './rows.js'
import { isResultTruncated } from './rows.js'
import type { CanUseToolFn } from '../kit/tool.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import { type Progress, type CrewmateToolInput, inputSchema, outputSchema, type CrewmateToolOutput } from './call/schema.js'
import { crewmateCwdQuestion } from './call/cwd.js'
import { mcpServerNamesWithTools, crewmateToolCall } from './call/call.js'
import { crewmateToolResultBlock } from './call/resultBlock.js'
export type { Progress, CrewmateToolInput, CrewmateToolOutput } from './call/schema.js'
export { inputSchema, outputSchema } from './call/schema.js'
export { resolveCrewmateCwd, crewmateCwdQuestion } from './call/cwd.js'

const RESULT_SIZE_CAP = 100_000


type InputSchema = ReturnType<typeof inputSchema>
type OutputSchema = ReturnType<typeof outputSchema>

const CREWMATE_DESCRIPTION =
  'Delegate a task to a crewmate: a new crewmate that handles complex, multi-step work on its own'

const CREWMATE_WIRE_DESCRIPTION =
  'Launch an independent crewmate from a task brief and return its report. The child does not inherit this conversation; its session-owned processes end with it.'

export const CrewmateTool = buildTool({
  name: CREWMATE_TOOL_NAME,
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
    return CREWMATE_DESCRIPTION
  },
  wireDescription(fullPrompt: string): string {
    const roster = agentRosterOf(fullPrompt)
    return roster ? `${CREWMATE_WIRE_DESCRIPTION}\n\n${roster}` : CREWMATE_WIRE_DESCRIPTION
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
      const denyRule = getDenyRuleForAgent(permissionContext, CREWMATE_TOOL_NAME, agent.agentType)
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
  async checkPermissions(input: CrewmateToolInput, context: ToolUseContext) {
    if (input.cwd) {
      const decision = crewmateCwdQuestion(input.cwd, context.getAppState().toolPermissionContext)
      if (decision !== null) return decision
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  getActivityDescription(input?: Partial<CrewmateToolInput>) {
    return input?.description ?? 'Running task'
  },
  extractSearchText(output: CrewmateToolOutput): string {
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
  renderGroupedToolUse: UI.renderGroupedCrewmateToolUse,
  isResultTruncated,
  async call(
    input: CrewmateToolInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress,
  ) {
    return crewmateToolCall(input, context, canUseTool, parentAssistantMessage, onProgress)
  },
  mapToolResultToToolResultBlockParam(output: CrewmateToolOutput, toolUseID: string) {
    return crewmateToolResultBlock(output, toolUseID)
  },
} satisfies ToolDef<InputSchema, CrewmateToolOutput, Progress>)
