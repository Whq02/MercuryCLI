
import '../../utils/path.js'
import '../../utils/semanticBoolean.js'
import '../../bootstrap/state.js'
import '../../utils/permissions/filesystem.js'
import '../../utils/permissions/PermissionMode.js'
import '../../constants/prompts.js'
import '../../constants/subagentDoctrine.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import '../../tasks/LocalAgentTask/LocalAgentTask.js'
import '../../tasks/LocalAgentTask/launchReceipts.js'
import '../../utils/task/framework.js'
import { buildTool, type Tool as ToolShape, type ToolDef, type ToolUseContext } from '../../Tool.js'
import '../../tools.js'
import '../../Task.js'
import '../../utils/agentContext.js'
import '../../utils/cwd.js'
import '../../utils/platform.js'
import '../../utils/windowsPaths.js'
import '../../utils/debug.js'
import '../../utils/errors.js'
import '../../utils/effort.js'
import '../../utils/agentDefaults.js'
import { getDenyRuleForAgent } from '../../utils/permissions/decision/rules.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../../utils/permissions/ruleReason.js'
import '../../utils/promptCategory.js'
import '../../utils/crew/agentLaunchPlan.js'
import '../../utils/model/agent.js'
import '../../utils/model/modelLookup.js'
import '../../utils/model/modelNameRoad.js'
import '../../utils/crew/engineDispatch.js'
import '../../services/providers/primaryBackend.js'
import '../../utils/task/diskOutput.js'
import '../../utils/worktree.js'
import '../../utils/worktreeReadiness.js'
import '../../utils/crew/crewWorktreeReminder.js'
import '../../utils/lazySchema.js'
import '../../utils/messages.js'
import '../BashTool/toolName.js'
import '../FileReadTool/prompt.js'
import '../ResumeAgentTool/constants.js'
import '../../utils/crew/crewStart.js'
import './foregroundExecution.js'
import './agentToolUtils.js'
import '../SyntheticOutputTool/structuredOutputTool.js'
import { AGENT_TOOL_NAME } from './constants.js'
import './frozenWorktreeNotice.js'
import './worktreePrepareNotice.js'
import './loadAgentsDir.js'
import { agentRosterOf, getPrompt, withoutAgentRoster } from './prompt.js'
import './runAgent.js'
import '../../services/crewBoard/seam.js'
import './agentColorManager.js'
import * as UI from './UI.js'
import { isResultTruncated } from './UI.js'
import '../../services/agentResults/ingest.js'
import '../../services/agentResults/normalize.js'
import '../../utils/sleep.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { ZodType } from 'zod'
import type { AssistantMessage } from '../../types/message.js'
import { type Progress, type AgentToolInput, inputSchema, outputSchema, type AgentToolOutput } from './agent/schema.js'
import { agentCwdQuestion } from './agent/cwd.js'
import { mcpServerNamesWithTools, agentToolCall } from './agent/call.js'
import { agentToolResultBlock } from './agent/resultBlock.js'
export type { Progress, AgentToolInput, AgentToolOutput } from './agent/schema.js'
export { inputSchema, outputSchema } from './agent/schema.js'
export { resolveAgentCwd, agentCwdQuestion } from './agent/cwd.js'

const RESULT_SIZE_CAP = 100_000


export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  maxResultSizeChars: RESULT_SIZE_CAP,
  searchHint: 'delegate a bounded task to an independent agent and receive its report',
  searchKeywords: ['swarm', 'agents', 'seats', 'team', 'launch', 'wave', 'delegate', 'crew', 'subagent'],
  get inputSchema(): ZodType<AgentToolInput, AgentToolInput> {
    return inputSchema() as unknown as ZodType<AgentToolInput, AgentToolInput>
  },
  get outputSchema(): ZodType {
    return outputSchema() as unknown as ZodType
  },
  async description() {
    return 'Delegate a task to a crewmate: a new crewmate that handles complex, multi-step work on its own'
  },
  wireDescription(fullPrompt: string) {
    const roster = agentRosterOf(fullPrompt)
    return `Launch an independent crewmate from a task brief and return its report. The child does not inherit this conversation; its session-owned processes end with it.${roster ? `\n\n${roster}` : ''}`
  },
  manualText(fullPrompt: string) {
    return withoutAgentRoster(fullPrompt)
  },
  async prompt(options: {
    getToolPermissionContext: () => Promise<
      ReturnType<ToolUseContext['getAppState']>['toolPermissionContext']
    >
    tools: ToolShape[]
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }) {
    const serversWithTools = mcpServerNamesWithTools(options.tools)
    const mcpEligible = options.agents.filter((agent: AgentDefinition) => {
      const required = agent.requiredMcpServers
      if (!required || required.length === 0) return true
      return required.every((pattern: string) =>
        serversWithTools.some(name =>
          name.toLowerCase().includes(pattern.toLowerCase()),
        ),
      )
    })
    const permissionContext = await options.getToolPermissionContext()
    const refusals = new Map<string, string>()
    for (const agent of mcpEligible) {
      const rule = getDenyRuleForAgent(permissionContext, AGENT_TOOL_NAME, agent.agentType)
      if (rule) refusals.set(agent.agentType, refusalWithReason(ruleSentence('launching it', 'deny', rule), reasonForRule(permissionContext, rule)))
    }
    return getPrompt(mcpEligible, false, options.allowedAgentTypes, new Set(options.tools.map(tool => tool.name)), refusals)
  },
  isEnabled(): boolean {
    return evaluateLaunchAuthority('subagents').allowed
  },
  isReadOnly(): boolean {
    return true
  },
  isConcurrencySafe(): boolean {
    return true
  },
  async checkPermissions(input: AgentToolInput, context: ToolUseContext) {
    const question =
      input.cwd !== undefined
        ? agentCwdQuestion(input.cwd, context.getAppState().toolPermissionContext)
        : null
    if (question !== null) return question
    return { behavior: 'allow' as const, updatedInput: input }
  },
  getActivityDescription(input?: AgentToolInput): string {
    return input?.description ?? 'Running task'
  },
  extractSearchText(output: AgentToolOutput): string {
    const content = (output as { content?: Array<{ text?: string }> }).content
    if (!Array.isArray(content)) return ''
    return content
      .map(block => block?.text ?? '')
      .filter(text => text !== '')
      .join('\n')
  },
  userFacingName: UI.userFacingName,
  userFacingNameBackgroundColor: UI.userFacingNameBackgroundColor,
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolUseTag: UI.renderToolUseTag,
  renderToolUseProgressMessage: UI.renderToolUseProgressMessage,
  renderToolUseRejectedMessage: UI.renderToolUseRejectedMessage,
  renderToolUseErrorMessage: UI.renderToolUseErrorMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
  renderGroupedToolUse: UI.renderGroupedAgentToolUse,
  isResultTruncated,

  call(
    input: AgentToolInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress?: (progress: { toolUseID: string; data: Progress }) => void,
  ) {
    return agentToolCall(input, context, canUseTool, parentAssistantMessage, onProgress)
  },

  mapToolResultToToolResultBlockParam(
    output: AgentToolOutput,
    toolUseID: string,
  ) {
    return agentToolResultBlock(output, toolUseID)
  },
} satisfies ToolDef<
  ZodType<AgentToolInput, AgentToolInput>,
  AgentToolOutput,
  Progress
>)

