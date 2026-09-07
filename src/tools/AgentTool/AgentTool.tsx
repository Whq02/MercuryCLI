
import { z, type ZodType } from 'zod'
import { decodePermissionModeSpelling } from '../../types/permissions.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import {
  getMainThreadAgentType,
  getSdkAgentProgressSummariesEnabled,
} from '../../bootstrap/state.js'
import {
  enhanceSystemPromptWithEnvDetails,
  getSystemPrompt,
} from '../../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { agentFanoutCap, buildSubagentMercurySections } from '../../constants/subagentDoctrine.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { harnessEffortFact, noteHarnessBoundary } from '../../services/mission/harnessApplication.js'
import {
  registerAgentName,
  registerAsyncAgent,
  setAgentPendingAsks,
  setAgentWaitLine,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { foregroundNotKeptLine, type BackgroundHandoverReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import {
  buildTool,
  toolMatchesName,
  type Tool as ToolShape,
  type ToolDef,
  type ToolUseContext,
} from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import { generateTaskId } from '../../Task.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { asAgentId, type AgentId } from '../../types/ids.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../../utils/agentContext.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { AGENT_DISPATCH_MODELS } from '../../utils/model/aliases.js'
import { SEAT_ALLOWED_FAMILIES } from '../../utils/model/seatSlots.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../utils/effort.js'
import { subagentConcurrencyCap, subagentDefaultEffort } from '../../utils/agentDefaults.js'
import { filterDeniedAgents } from '../../utils/permissions/decision/rules.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  readAgentMetadata,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  buildAgentLaunchPlan,
} from '../../utils/swarm/agentLaunchPlan.js'
import {
  engineDispatchModelsForSchema,
  resolveEngineDispatch,
} from '../../utils/swarm/engineDispatch.js'
import { describeAgentRuntimeRef } from '../../services/providers/primaryBackend.js'
import { decodeAgentType } from '../../utils/swarm/roleResolver.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  getParentSessionId,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import {
  createAgentWorktree,
  preflightWorktreeCapability,
  settleAgentWorktree,
} from '../../utils/worktree.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createUserMessage } from '../../utils/messages.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { spawnTeammate } from '../shared/spawnMultiAgent.js'
import {
  runForegroundAgentExecution,
  type ForegroundAgentMetadata,
} from './foregroundExecution.js'
import {
  agentToolResultSchema,
  PROMOTED_NARRATION_NOTE,
  resolveWorkerTools,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import { getSchemaBoundStructuredOutputTool } from '../WorkflowTool/structuredOutputTool.js'
import {
  AGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
} from './constants.js'
import {
  buildForkedMessages,
  buildFrozenWorktreeNotice,
  buildWorktreeNotice,
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
} from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { getPrompt } from './prompt.js'
import { resolveAgentEffort, runAgent, type RunAgentParams } from './runAgent.js'
import { setAgentColor } from './agentColorManager.js'
import * as UI from './UI.js'
import { isResultTruncated } from './UI.js'
import type { AgentToolProgress, ShellProgress } from '../../types/tools.js'
import { envelopeFor } from '../../services/agentResults/ingest.js'
import { formatEnvelopeBlock } from '../../services/agentResults/normalize.js'

export type Progress = AgentToolProgress | ShellProgress

const BACKGROUND_TASKS_DISABLED = false

const DEFAULT_AGENT_TYPE = 'mercury-general'
const RESULT_SIZE_CAP = 100_000


export type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: string
  effort?: EffortLevel
  run_in_background?: boolean
  name?: string
  team_name?: string
  mode?: string
  isolation?: 'worktree'
  worktree_at?: string
  output_schema?: Record<string, unknown>
  schema_mode?: 'permissive' | 'strict'
  cwd?: string
}

function modelEnumValues(): [string, ...string[]] {
  return [
    ...AGENT_DISPATCH_MODELS,
    ...SEAT_ALLOWED_FAMILIES,
    ...engineDispatchModelsForSchema(),
  ] as [string, ...string[]]
}

function modelParamDescription(): string {
  const engines = engineDispatchModelsForSchema()
  const base =
    'Model override for this launch. Aliases select the family tier (their [1m] forms select the 1M-context variant) and a served Anthropic id names its model exactly; an explicit model here wins over the agent definition\'s own model; omitted, the agent inherits the parent\'s model.'
  const exactIds = engines.filter(id => id.includes('-') || id.includes('/'))
  return `${base} Engine backends all run in-process with this harness's own tools. Class aliases: 'gpt' (qualified OpenAI default) · 'glm' (Z.AI pin) · 'kimi' (Moonshot pin) · 'deepseek' (DeepSeek pin) · 'compat' (the operator-named OpenAI-compatible endpoint's first model) · 'huggingface' (the session's own Hugging Face model, else the router flagship) · 'local' (the session's own local model, else the first discovered one) · 'gemini' (the session's own Gemini model, else the live catalogue head) · 'openrouter' (the session's own OpenRouter model, else the auto router); exact catalogue-validated engine ids (gemini-*/openrouter/* included): ${exactIds.join(', ')}.`
}

function effortParamDescription(): string {
  return `Reasoning effort for this agent: ${EFFORT_LEVELS.join(' | ')}. Omitted, the configured sub-agent default applies (high unless the operator changed it in /config) — never your own level, so a supercode session does not multiply every agent to max. A level the agent's model does not serve runs the nearest level it does and the transcript says so; a model with no effort control runs without one. Setting it also turns on extended reasoning where the model supports it. Spend the top tiers on the hardest judge and verify work.`
}

export const inputSchema = lazySchema(() => {
  const forkOn = isForkSubagentEnabled()
  const base = {
    description: z
      .string()
      .describe('A short (3-5 word) summary of the task'),
    prompt: z.string().describe('The task briefing handed to the agent'),
    subagent_type: z
      .string()
      .optional()
      .describe(`Which agent type to run. Omitted ⇒ the ${DEFAULT_AGENT_TYPE} agent.`),
    model: z
      .enum(modelEnumValues())
      .optional()
      .describe(modelParamDescription()),
    effort: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe(effortParamDescription()),
    ...(BACKGROUND_TASKS_DISABLED || forkOn
      ? {}
      : {
          run_in_background: semanticBoolean(z.boolean().optional()).describe(
            'Launch asynchronously: returns an acknowledgement now and a completion notification later.',
          ),
        }),
    name: z
      .string()
      .optional()
      .refine(value => value === undefined || (!value.includes('@') && value !== '*'), {
        message:
          'An agent name must be addressable by SendMessage: it cannot contain "@" or be "*".',
      })
      .describe(
        'Name for the spawned agent; makes it addressable via SendMessage({to: name}) while it runs.',
      ),
    team_name: z.string().optional().describe('Team for a teammate spawn.'),
    mode: z
      .string()
      .optional()
      .describe('Permission mode for the spawned teammate.'),
    isolation: z
      .literal('worktree')
      .optional()
      .describe('Run the agent in a temporary git worktree.'),
    worktree_at: z
      .string()
      .optional()
      .describe(
        "With isolation 'worktree': pin the worktree to this commit, detached — the agent reads a frozen tree no later commit or edit can move (a reviewer reads exactly the reviewed commit). The spelling must resolve to a commit in the repository.",
      ),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'JSON Schema for a STRUCTURED final answer: the agent finalizes through a schema-bound tool and the result carries parsed data alongside the prose.',
      ),
    schema_mode: z
      .enum(['permissive', 'strict'])
      .optional()
      .describe(
        "With output_schema: 'strict' fails the dispatch when no conforming payload was produced; 'permissive' (default) records the miss and keeps the prose.",
      ),
  }
  return z.object(base)
})


export const outputSchema = lazySchema(() => {
  const result = agentToolResultSchema()
  return z.union([
    result.extend({
      status: z.literal('completed'),
      prompt: z.string(),
      worktreePath: z.string().optional(),
      worktreeBranch: z.string().optional(),
    }),
    result.extend({
      status: z.literal('failed'),
      error: z.string(),
      prompt: z.string(),
      worktreePath: z.string().optional(),
      worktreeBranch: z.string().optional(),
    }),
    z.object({
      status: z.literal('async_launched'),
      agentId: z.string().describe('The launched agent\'s id'),
      description: z.string().describe('The task description'),
      prompt: z.string().describe('The prompt handed to the agent'),
      outputFile: z
        .string()
        .describe('Output-file path for progress checks'),
      canReadOutputFile: z
        .boolean()
        .optional()
        .describe('Whether the caller can read the output file'),
      modelNote: z.string().optional().describe('The model-floor note'),
      agentName: z.string().optional().describe('The name the launch gave the agent — an address beside the id'),
      backgroundReason: z
        .enum(['turn-interrupted', 'backgrounded', 'agent-type', 'sibling-ended'])
        .optional()
        .describe('Why a foreground ask ran in the background: the turn was interrupted, the agent was moved, the type always does, or a sibling agent failed or stopped and the group wait returned'),
      siblingEnd: z
        .object({ taskId: z.string(), description: z.string(), status: z.enum(['failed', 'stopped']), error: z.string().optional() })
        .optional()
        .describe('The sibling whose failure or stop returned the group wait'),
    }),
  ])
})

export type AgentToolOutput = z.infer<ReturnType<typeof outputSchema>> & {
  isAsync?: true
  agentName?: string
  teamName?: string
}


function mcpServerNamesWithTools(tools: readonly ToolShape[]): string[] {
  const names = new Set<string>()
  for (const tool of tools) {
    const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool.name)
    if (match) names.add(match[1]!)
  }
  return [...names]
}

async function waitForRequiredMcpServers(
  definition: AgentDefinition,
  context: ToolUseContext,
): Promise<void> {
  const required = definition.requiredMcpServers
  if (!required || required.length === 0) return
  const deadline = Date.now() + 30_000
  const clients = () => context.getAppState().mcp.clients ?? []
  const matchesRequired = (name: string) =>
    required.some(pattern =>
      name.toLowerCase().includes(pattern.toLowerCase()),
    )
  while (Date.now() < deadline) {
    const pendingRequired = clients().some(
      client => client.type === 'pending' && matchesRequired(client.name),
    )
    if (!pendingRequired) break
    const failedRequired = clients().some(
      client => client.type === 'failed' && matchesRequired(client.name),
    )
    if (failedRequired) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const serversWithTools = mcpServerNamesWithTools(
    context.getAppState().mcp.tools ?? [],
  )
  const missing = required.filter(
    pattern =>
      !serversWithTools.some(name =>
        name.toLowerCase().includes(pattern.toLowerCase()),
      ),
  )
  if (missing.length > 0) {
    throw new Error(
      `Agent type '${definition.agentType}' requires MCP server(s) matching: ${missing.join(', ')}. ` +
        `Servers currently exposing tools: ${serversWithTools.length > 0 ? [...new Set(serversWithTools)].join(', ') : 'none'}. ` +
        'Configure the required server with the /mcp command.',
    )
  }
}

function usageBlock(data: {
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}): string {
  const rows = [
    ...(data.totalTokens !== undefined ? [`total_tokens: ${data.totalTokens}`] : []),
    ...(data.totalToolUseCount !== undefined ? [`tool_uses: ${data.totalToolUseCount}`] : []),
    ...(data.totalDurationMs !== undefined ? [`duration_ms: ${data.totalDurationMs}`] : []),
  ]
  return rows.length > 0 ? `<usage>${rows.join('\n')}</usage>` : '<usage>unreported</usage>'
}

function continuationHint(agentId: string, name?: string): string {
  return `agentId: ${agentId} (internal — do not mention it to the user). To continue this agent, use ${SEND_MESSAGE_TOOL_NAME} addressed to that id${name ? ` or to its name "${name}"` : ''}.`
}


export const SUBAGENT_BRIEFING_LEAD =
  'delegates to a separate sub-agent with this briefing (its rules bind that sub-agent alone, never this session):'

export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  maxResultSizeChars: RESULT_SIZE_CAP,
  searchHint: 'delegate a task to a subagent that works on its own',
  get inputSchema(): ZodType<AgentToolInput, AgentToolInput> {
    return inputSchema() as unknown as ZodType<AgentToolInput, AgentToolInput>
  },
  get outputSchema(): ZodType {
    return outputSchema() as unknown as ZodType
  },
  async description() {
    return 'Launch a new agent to handle complex, multi-step tasks on its own'
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
    const effective = filterDeniedAgents(
      mcpEligible as AgentDefinition[],
      permissionContext,
      AGENT_TOOL_NAME,
    )
    return getPrompt(effective, false, options.allowedAgentTypes)
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
  async checkPermissions(input: AgentToolInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  getActivityDescription(input?: AgentToolInput): string {
    return input?.description ?? 'Running task'
  },
  toAutoClassifierInput(input: AgentToolInput): string {
    const tags: string[] = []
    if (input.subagent_type) tags.push(input.subagent_type)
    if (input.mode) tags.push(`mode=${input.mode}`)
    const lead = tags.length > 0 ? `(${tags.join(', ')}) ` : ''
    return `${lead}${SUBAGENT_BRIEFING_LEAD} ${input.prompt}`
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

  async call(
    input: AgentToolInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress?: (progress: { toolUseID: string; data: Progress }) => void,
  ) {
    const startTime = Date.now()
    const options = context.options

    if (input.team_name && !isAgentSwarmsEnabled()) {
      throw new Error(
        'The team_name parameter requires agent teams, which are not available in this session.',
      )
    }

    const authority = evaluateLaunchAuthority('subagents')
    if (!authority.allowed) {
      throw new Error(authority.reason)
    }

    const teamName = isAgentSwarmsEnabled()
      ? (input.team_name ?? getTeamName())
      : undefined

    if (isTeammate() && teamName && input.name) {
      throw new Error(
        'Teammates cannot spawn teammates — the roster is flat and has one lead. Omit the name parameter to launch a plain subagent instead.',
      )
    }

    if (isInProcessTeammate() && input.run_in_background && teamName) {
      throw new Error(
        'An in-process teammate cannot spawn a background agent — its lifecycle is bound to the leader process. Launch the agent synchronously instead.',
      )
    }

    const engineDispatch = await resolveEngineDispatch(input.model)

    if (teamName && input.name) {
      const requestedType = decodeAgentType(input.subagent_type)
      const definitions = options.agentDefinitions?.activeAgents ?? []
      const teammateDefinition = definitions.find(
        agent => agent.agentType === requestedType,
      )
      if (teammateDefinition?.color) {
        setAgentColor(teammateDefinition.agentType, teammateDefinition.color)
      }
      const teammateModel =
        engineDispatch?.model ?? input.model ?? teammateDefinition?.model
      const spawned = await spawnTeammate(
        {
          name: input.name,
          prompt: input.prompt,
          team_name: teamName,
          ...(input.subagent_type ? { agent_type: input.subagent_type } : {}),
          ...(teammateModel ? { model: teammateModel } : {}),
          plan_mode_required:
            input.mode !== undefined && decodePermissionModeSpelling(input.mode) === 'strategy',
          description: input.description,
          ...(parentAssistantMessage.requestId
            ? { invokingRequestId: parentAssistantMessage.requestId }
            : {}),
        },
        context,
      )
      const record = spawned.data
      return {
        data: {
          ...record,
          status: 'teammate_spawned',
          agentId: record.agent_id,
          agentName: input.name,
          teamName,
          prompt: input.prompt,
          description: input.description,
        } as never,
      }
    }

    const activeAgents = options.agentDefinitions?.activeAgents ?? []
    const allowedAgentTypes = options.agentDefinitions?.allowedAgentTypes
    const plan = buildAgentLaunchPlan({
      requestedType: input.subagent_type,
      activeAgents,
      allowedAgentTypes,
      toolPermissionContext: context.getAppState().toolPermissionContext,
      forkGateOn: isForkSubagentEnabled(),
      forkAgent: FORK_AGENT,
      defaultAgentType: DEFAULT_AGENT_TYPE,
      mainLoopModel: options.mainLoopModel,
      modelParam: engineDispatch ? undefined : (input.model as never),
      permissionMode: context.getAppState().toolPermissionContext
        .mode as never,
      isolationParam: input.isolation,
      runInBackground: input.run_in_background,
      backgroundTasksDisabled: BACKGROUND_TASKS_DISABLED,
      forceAsync: isForkSubagentEnabled(),
      ...(engineDispatch
        ? {
            engineDispatch: {
              backend: engineDispatch.backend,
              model: engineDispatch.model,
            },
          }
        : {}),
    })
    const agentDef = plan.definition

    if (plan.isForkPath) {
      const source = options.querySource
      if (
        source === 'agent:builtin:fork' ||
        isInForkChild(context.messages as Message[])
      ) {
        throw new Error(
          'A forked worker cannot fork again — execute the work directly.',
        )
      }
    }

    const fanout = subagentConcurrencyCap(agentFanoutCap())
    const runningAgents = getRunningTasks(context.getAppState()).filter(isLocalAgentTask).length
    if (runningAgents >= fanout.cap) {
      const door = fanout.source === 'env' ? 'MERCURY_AGENT_FANOUT_CAP' : 'Sub-agents at once in /config'
      throw new Error(
        `Agent dispatch refused: ${runningAgents} agent${runningAgents === 1 ? ' is' : 's are'} already running and the cap is ${fanout.cap} (${door}). Wait for one to finish, stop one, or continue the work directly.`,
      )
    }

    if (agentDef.background === true && isInProcessTeammate() && teamName) {
      throw new Error(
        `Agent type '${agentDef.agentType}' always runs in the background, and an in-process teammate cannot spawn background agents.`,
      )
    }

    await waitForRequiredMcpServers(agentDef, context)

    if (agentDef.color) setAgentColor(agentDef.agentType, agentDef.color)

    noteHarnessBoundary(
      'subagent-spawn',
      plan.model,
      harnessEffortFact(
        plan.model,
        resolveAgentEffort({
          effortOverride: input.effort,
          useExactTools: undefined,
          definitionEffort: agentDef.effort,
          defaultEffort: subagentDefaultEffort(),
        }),
      ),
    )

    const isFork = plan.isForkPath
    let promptMessages: Message[]
    let systemPromptOverride: string[] | undefined
    if (isFork) {
      const rendered = context.renderedSystemPrompt
      if (rendered) {
        systemPromptOverride = [...rendered]
      } else {
        try {
          systemPromptOverride = await buildParentEffectiveSystemPrompt(context)
        } catch (error) {
          logForDebugging(
            `AgentTool: fork prompt recompute failed: ${errorMessage(error)}`,
          )
        }
      }
      promptMessages = buildForkedMessages(input.prompt, parentAssistantMessage)
    } else {
      promptMessages = [createUserMessage({ content: input.prompt })]
      const willOverrideCwd = plan.isolation === 'worktree' || Boolean(input.cwd)
      if (!willOverrideCwd) {
        try {
          systemPromptOverride = await buildDefaultSystemPrompt(
            agentDef,
            context,
            plan.model,
          )
        } catch (error) {
          logForDebugging(
            `AgentTool: system prompt build failed: ${errorMessage(error)}`,
          )
        }
      }
    }

    const workerTools = isFork
      ? options.tools
      : resolveWorkerTools(
          agentDef,
          plan.workerPermissionMode,
          assembleToolPool(
            {
              ...context.getAppState().toolPermissionContext,
              mode: plan.workerPermissionMode,
            },
            context.getAppState().mcp.tools ?? [],
          ),
          plan.shouldRunAsync,
        )

    if (plan.isolation === 'worktree') {
      const capability = preflightWorktreeCapability()
      if (!capability.available) {
        throw new Error(
          `Worktree preflight (agent dispatch): ${capability.detail}`,
        )
      }
    }

    const earlyAgentId = generateTaskId('local_agent') as AgentId

    let worktreeInfo:
      | Awaited<ReturnType<typeof createAgentWorktree>>
      | undefined
    if (plan.isolation === 'worktree') {
      worktreeInfo = await createAgentWorktree(
        `agent-${earlyAgentId.slice(0, 8)}`,
        input.worktree_at !== undefined ? { at: input.worktree_at } : undefined,
      )
      if (isFork) {
        promptMessages = [
          ...promptMessages,
          createUserMessage({
            content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath),
          }),
        ]
      }
      if (input.worktree_at !== undefined && worktreeInfo.headCommit !== undefined) {
        promptMessages = [
          ...promptMessages,
          createUserMessage({
            content: buildFrozenWorktreeNotice(worktreeInfo.worktreePath, worktreeInfo.headCommit),
          }),
        ]
      }
    } else if (input.worktree_at !== undefined) {
      throw new Error("worktree_at needs isolation: 'worktree' — the pin names the commit a temporary worktree stands at.")
    }

    let cleanupDone = false
    const cleanupWorktreeIfNeeded = async (): Promise<{
      worktreePath?: string
      worktreeBranch?: string
    }> => {
      if (cleanupDone || !worktreeInfo) return {}
      cleanupDone = true
      if (worktreeInfo.hookBased) {
        logForDebugging('AgentTool: worktree kept (hook-created)')
        return { worktreePath: worktreeInfo.worktreePath }
      }
      const receipt = await settleAgentWorktree({ ...worktreeInfo })
      if (receipt.outcome === 'settled') {
        void writeAgentMetadata(asAgentId(earlyAgentId), {
          agentType: agentDef.agentType,
          model: plan.model,
          ...(input.description ? { description: input.description } : {}),
        }).catch(error =>
          logForDebugging(
            `AgentTool: settled-worktree metadata write failed: ${errorMessage(error)}`,
          ),
        )
        return {}
      }
      logForDebugging(
        `AgentTool: worktree kept (${receipt.outcome})${'summary' in receipt ? `: ${receipt.summary}` : ''}`,
      )
      return {
        worktreePath: receipt.worktreePath,
        ...(worktreeInfo.worktreeBranch
          ? { worktreeBranch: worktreeInfo.worktreeBranch }
          : {}),
      }
    }

    const rootSetAppState = context.setAppStateForTasks ?? context.setAppState

    const model = input.model
    const modelForRunLoop = engineDispatch
      ? plan.model
      : isFork
        ? undefined
        : model

    const metadataIsAsync =
      (input.run_in_background === true || agentDef.background === true) &&
      !BACKGROUND_TASKS_DISABLED

    const querySource =
      options.querySource ??
      getQuerySourceForAgent(agentDef.agentType, isBuiltInAgent(agentDef))

    const definitionSchema = (agentDef as { outputSchema?: Record<string, unknown> }).outputSchema
    const structuredOutputSpec = (() => {
      const schema = input.output_schema ?? definitionSchema
      if (schema === undefined) return undefined
      const bound = getSchemaBoundStructuredOutputTool(schema)
      if (bound.error !== undefined) {
        throw new Error(`output_schema is not a valid JSON Schema: ${bound.error}`)
      }
      return {
        schema,
        mode: input.schema_mode ?? ('permissive' as const),
        source: input.output_schema !== undefined ? ('dispatch' as const) : ('agent-definition' as const),
      }
    })()

    const metadata: ForegroundAgentMetadata = {
      prompt: input.prompt,
      resolvedAgentModel: plan.model,
      isBuiltInAgent: isBuiltInAgent(agentDef),
      startTime,
      agentType: agentDef.agentType,
      isAsync: metadataIsAsync,
      ...(structuredOutputSpec
        ? { structuredSpec: { mode: structuredOutputSpec.mode, source: structuredOutputSpec.source } }
        : {}),
    }

    const cwdOverride = input.cwd ?? worktreeInfo?.worktreePath

    const effectiveSystemPromptOverride = isFork
      ? systemPromptOverride
      : cwdOverride
        ? undefined
        : systemPromptOverride

    const runAgentParams: RunAgentParams = {
      agentDefinition: agentDef,
      promptMessages,
      toolUseContext: context,
      canUseTool,
      isAsync: plan.shouldRunAsync,
      querySource,
      ...(structuredOutputSpec ? { structuredOutputSpec } : {}),
      override: {
        ...(effectiveSystemPromptOverride
          ? { systemPrompt: effectiveSystemPromptOverride }
          : {}),
      },
      ...(modelForRunLoop !== undefined ? { model: modelForRunLoop } : {}),
      ...(input.effort !== undefined ? { effortOverride: input.effort } : {}),
      availableTools: workerTools,
      ...(isFork
        ? {
            useExactTools: true,
            forkContextMessages: context.messages as Message[],
          }
        : {}),
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      description: input.description,
      onWait: line => setAgentWaitLine(earlyAgentId, line, rootSetAppState),
      onPendingAsks: count => setAgentPendingAsks(earlyAgentId, count, rootSetAppState),
    }

    const agentContext: SubagentContext = {
      agentType: 'subagent',
      agentId: earlyAgentId,
      parentSessionId: getParentSessionId(),
      subagentName: agentDef.agentType,
      isBuiltIn: isBuiltInAgent(agentDef),
      invocationKind: 'spawn',
      invokingRequestId: parentAssistantMessage.requestId,
      invocationEmitted: false,
    }

    if (plan.shouldRunAsync) {
      const task = registerAsyncAgent({
        agentId: earlyAgentId,
        description: input.description,
        prompt: input.prompt,
        setAppState: rootSetAppState,
        selectedAgent: agentDef,
        model: plan.model,
        toolUseId: context.toolUseId,
      })

      if (input.name) registerAgentName(input.name, earlyAgentId, rootSetAppState)

      const enableSummarization =
        isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled()

      const lifecycle = () =>
        runAsyncAgentLifecycle({
          taskId: earlyAgentId,
          abortController: task.abortController!,
          makeStream: (onCacheSafeParams, onQueryProgress) =>
            runAgent({
              ...runAgentParams,
              override: {
                ...runAgentParams.override,
                agentId: earlyAgentId,
                abortController: task.abortController!,
              },
              onCacheSafeParams: onCacheSafeParams as never,
              ...(onQueryProgress !== undefined ? { onQueryProgress } : {}),
            }),
          metadata,
          description: input.description,
          toolUseContext: context,
          rootSetAppState,
          agentIdForCleanup: earlyAgentId,
          enableSummarization,
          getWorktreeResult: cleanupWorktreeIfNeeded,
          canUseTool,
        })

      void runWithAgentContext(agentContext, () =>
        cwdOverride
          ? runWithCwdOverride(cwdOverride, lifecycle)
          : lifecycle(),
      )

      const canReadOutputFile = options.tools.some(
        tool =>
          toolMatchesName(tool, FILE_READ_TOOL_NAME) ||
          toolMatchesName(tool, BASH_TOOL_NAME),
      )
      return {
        data: {
          isAsync: true as const,
          status: 'async_launched' as const,
          agentId: earlyAgentId,
          description: input.description,
          prompt: input.prompt,
          outputFile: getTaskOutputPath(earlyAgentId),
          canReadOutputFile,
          ...(plan.modelNote ? { modelNote: plan.modelNote } : {}),
          ...(input.name ? { agentName: input.name } : {}),
          ...(input.run_in_background === false && agentDef.background === true
            ? { backgroundReason: 'agent-type' as const }
            : {}),
          runtimeRef: describeAgentRuntimeRef(plan.model),
        } as never,
      }
    }

    const result = await runWithAgentContext(agentContext, () => {
      const execute = () =>
        runForegroundAgentExecution({
          runAgentParams,
          promptMessages,
          prompt: input.prompt,
          description: input.description,
          name: input.name,
          ...(plan.modelNote ? { modelNote: plan.modelNote } : {}),
          metadata,
          startTime,
          syncAgentId: earlyAgentId,
          syncAgentContext: agentContext,
          selectedAgent: agentDef,
          toolUseContext: context,
          assistantMessage: parentAssistantMessage,
          onProgress,
          rootSetAppState,
          backgroundTasksDisabled: BACKGROUND_TASKS_DISABLED,
          cleanupWorktreeIfNeeded,
        })
      return cwdOverride
        ? runWithCwdOverride(cwdOverride, execute)
        : execute()
    })

    return { data: result.data }
  },

  mapToolResultToToolResultBlockParam(
    output: AgentToolOutput,
    toolUseID: string,
  ) {
    const data = output as AgentToolOutput & {
      agentId?: string
      content?: Array<{ type: 'text'; text: string }>
      totalTokens?: number
      totalToolUseCount?: number
      totalDurationMs?: number
      outcome?: { status: string; promotedNarration?: boolean }
      agentType?: string
      error?: string
      worktreePath?: string
      worktreeBranch?: string
      agentName?: string
      teamName?: string
    }
    const status = (data as { status?: string }).status

    if (status === 'teammate_spawned') {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: [
          {
            type: 'text' as const,
            text: `Teammate spawned. Agent id: ${data.agentId}, name: ${data.agentName}, team: ${data.teamName}. The agent is running and will receive instructions through its mailbox.`,
          },
        ],
      }
    }

    if (status === 'async_launched') {
      const async = data as unknown as {
        agentId: string
        outputFile: string
        canReadOutputFile: boolean
        modelNote?: string
        agentName?: string
        backgroundReason?: BackgroundHandoverReason
        siblingEnd?: { taskId: string; description: string; status: 'failed' | 'stopped'; error?: string }
      }
      const lines = [
        'Agent launched in the background.',
        ...(async.backgroundReason ? [foregroundNotKeptLine(async.backgroundReason, async.siblingEnd)] : []),
        ...(async.modelNote ? [async.modelNote] : []),
        continuationHint(async.agentId, async.agentName),
        'The agent is working in the background — you will be notified automatically when it completes.',
      ]
      if (async.canReadOutputFile) {
        lines.push(
          'Do not repeat the launched agent\'s work: keep off the same files and subject matter — either pick up something disjoint or give the user a one-line note about the launch and stop.',
          `Output file: ${async.outputFile} (progress may be inspected with the read tool or a shell tail ONLY when the user asks).`,
        )
      } else {
        lines.push(
          'Give the user a one-line note about the launch and stop — emit nothing further; the results will arrive in a later message.',
        )
      }
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    }

    if (status === 'failed') {
      const partialBlocks = data.content ?? []
      const paused = typeof data.error === 'string' && data.error.startsWith('paused — ')
      const blocks: Array<{ type: 'text'; text: string }> =
        partialBlocks.length > 0
          ? [...partialBlocks]
          : [
              {
                type: 'text' as const,
                text: paused ? 'The subagent paused before returning any output.' : 'The subagent failed before returning any output.',
              },
            ]
      const failedTrailer = [
        `Agent execution failed: ${data.error ?? 'unknown error'}`,
        'Anything above is partial work, not a final answer — it was captured before the failure and must not be read as a conclusion; its work is kept on its transcript.',
        continuationHint(String(data.agentId ?? '')),
        usageBlock(data),
      ]
      const failedEnvelope = envelopeFor(data)
      if (failedEnvelope) failedTrailer.push(formatEnvelopeBlock(failedEnvelope))
      blocks.push({
        type: 'text' as const,
        text: failedTrailer.join('\n'),
      })
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        is_error: true,
        content: blocks,
      }
    }

    if (status === 'completed') {
      let bodyBlocks = data.content ?? []
      if (bodyBlocks.length === 0) {
        bodyBlocks = [
          {
            type: 'text' as const,
            text: 'The subagent finished without producing any output.',
          },
        ]
      }
      const blocks: Array<{ type: 'text'; text: string }> = []
      if (
        data.outcome?.status === 'completed' &&
        data.outcome.promotedNarration
      ) {
        blocks.push({ type: 'text' as const, text: PROMOTED_NARRATION_NOTE })
      }
      blocks.push(...bodyBlocks)
      if (
        data.agentType !== undefined &&
        ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) &&
        !data.worktreePath
      ) {
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: blocks,
        }
      }
      const trailerParts = [continuationHint(String(data.agentId ?? ''))]
      if (data.worktreePath) {
        trailerParts.push(
          `Worktree kept: ${data.worktreePath}${data.worktreeBranch ? ` (branch ${data.worktreeBranch})` : ''}`,
        )
      }
      trailerParts.push(usageBlock(data))
      const envelope = envelopeFor(data)
      if (envelope) trailerParts.push(formatEnvelopeBlock(envelope))
      blocks.push({ type: 'text' as const, text: trailerParts.join('\n') })
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: blocks,
      }
    }

    throw new Error(`Unexpected agent tool result status: ${String(status)}`)
  },
} satisfies ToolDef<
  ZodType<AgentToolInput, AgentToolInput>,
  AgentToolOutput,
  Progress
>)

async function buildParentEffectiveSystemPrompt(
  context: ToolUseContext,
): Promise<string[]> {
  const options = context.options
  const defaultSystemPrompt = await getSystemPrompt(
    options.tools,
    options.mainLoopModel,
    Array.from(
      context.getAppState().toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    options.mcpClients,
  )
  const effective = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: (
      options.agentDefinitions?.activeAgents ?? []
    ).find(agent => agent.agentType === getMainThreadAgentType()),
    toolUseContext: context,
    customSystemPrompt: options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  })
  return [...effective]
}

async function buildDefaultSystemPrompt(
  definition: AgentDefinition,
  context: ToolUseContext,
  childModel: string,
): Promise<string[]> {
  const ownPrompt = isBuiltInAgent(definition)
    ? definition.getSystemPrompt({ toolUseContext: context })
    : definition.getSystemPrompt()
  const doctrine = buildSubagentMercurySections({
    agentDefinition: definition,
    toolUseContext: context,
  })
  return enhanceSystemPromptWithEnvDetails(
    [...doctrine, ownPrompt],
    childModel,
    Array.from(
      context.getAppState().toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
  )
}
