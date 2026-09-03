// The `Agent` tool: input/output schemas, launch
// resolution, worktree isolation, sync/async routing, and the
// model-visible result text. Mercury layers: switchboard launch authority,
// engine-backend dispatch, the model-floor note, the result envelope,
// one-shot trailer suppression, and the search projection.
//
// STRUCTURAL RULING: this module must NOT
// read the shared agent-result schema at module-evaluation time — the
// output-schema factory below invokes it on first access only, so any
// import evaluation order works (the AgentTool ↔ agentToolUtils cycle).

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
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
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
  resolveAgentTools,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import { getSchemaBoundStructuredOutputTool } from '../WorkflowTool/structuredOutputTool.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
} from './constants.js'
import {
  buildForkedMessages,
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
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { envelopeFor } from '../../services/agentResults/ingest.js'
import { formatEnvelopeBlock } from '../../services/agentResults/normalize.js'

/** Progress union: this tool's own payload plus forwarded shell progress. */
export type Progress = AgentToolProgress | ShellProgress

/** Always enabled: the compat compat kill retired with the compat
 *  wave (no MERCURY primary). */
const BACKGROUND_TASKS_DISABLED = false

/** Auto-background gate key. */
const AUTO_BACKGROUND_GATE = 'mercury_auto_background_agents'
const AUTO_BACKGROUND_THRESHOLD_MS = 120_000

const DEFAULT_AGENT_TYPE = 'general-purpose'
const RESULT_SIZE_CAP = 100_000

/** The auto-background threshold, checked lazily (never at module load). */
function autoBackgroundMs(): number | undefined {
  const enabled = getFeatureValue_CACHED_MAY_BE_STALE(AUTO_BACKGROUND_GATE, false)
  if (!enabled) return undefined
  return AUTO_BACKGROUND_THRESHOLD_MS
}

// ── Input ───────────────────────────────────────────────────────────

/** The internal input type admits every field — gate flips mid-session must
 *  never produce a validation failure, only an ignored parameter. */
export type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: string
  run_in_background?: boolean
  name?: string
  team_name?: string
  mode?: string
  isolation?: 'worktree'
  output_schema?: Record<string, unknown>
  schema_mode?: 'permissive' | 'strict'
  /** Present in the internal type only — omitted from the exported schema. */
  cwd?: string
}

function modelEnumValues(): [string, ...string[]] {
  // The plain dispatch aliases, plus the engine choices only while the
  // engine flag is armed — unarmed, the schema is byte-identical to the
  // no-engine form (prompt-cache stability).
  return [
    ...AGENT_DISPATCH_MODELS,
    ...engineDispatchModelsForSchema(),
  ] as [string, ...string[]]
}

function modelParamDescription(): string {
  const engines = engineDispatchModelsForSchema()
  const base =
    'Model override for this launch. Aliases select the family tier (their [1m] forms select the 1M-context variant); an explicit model here wins over the agent definition\'s own model; omitted, the agent inherits the parent\'s model.'
  const exactIds = engines.filter(id => id.includes('-') || id.includes('/'))
  return `${base} Engine backends all run in-process with this harness's own tools. Class aliases: 'gpt' (qualified OpenAI default) · 'glm' (Z.AI pin) · 'kimi' (Moonshot pin) · 'deepseek' (DeepSeek pin) · 'compat' (the operator-named OpenAI-compatible endpoint's first model) · 'huggingface' (the session's own Hugging Face model, else the router flagship) · 'local' (the session's own local model, else the first discovered one) · 'gemini' (the session's own Gemini model, else the live catalogue head) · 'openrouter' (the session's own OpenRouter model, else the auto router); exact catalogue-validated engine ids (gemini-*/openrouter/* included): ${exactIds.join(', ')}.`
}

export const inputSchema = lazySchema(() => {
  const forkOn = isForkSubagentEnabled()
  const base = {
    description: z
      .string()
      .describe('A short (3-5 word) summary of the task'),
    prompt: z.string().describe('The task briefing handed to the agent'),
    // ONE static text — gate-varying schema text is a removed hazard; the
    // fork behaviour is conveyed by the tool prompt, not a mutating schema.
    subagent_type: z
      .string()
      .optional()
      .describe(`Which agent type to run. Omitted ⇒ the ${DEFAULT_AGENT_TYPE} agent.`),
    model: z
      .enum(modelEnumValues())
      .optional()
      .describe(modelParamDescription()),
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
        // The name is registered verbatim and listed as a SendMessage
        // recipient, so it must be addressable: SendMessage reads '@' as the
        // team-suffix separator and '*' as the broadcast token. A name
        // carrying either would appear in the listing yet be unmessageable —
        // the generator and the recipient validator share one grammar.
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

// ── Output ──────────────────────────────────────────────────────────

/** Lazily built: reads the shared result schema on FIRST ACCESS only
 * (STRUCTURAL RULING — the import cycle makes eager reads a TDZ). */
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
      // Optional: a persisted row missing it must still validate on resume.
      canReadOutputFile: z
        .boolean()
        .optional()
        .describe('Whether the caller can read the output file'),
      modelNote: z.string().optional().describe('The model-floor note'),
    }),
  ])
})

export type AgentToolOutput = z.infer<ReturnType<typeof outputSchema>> & {
  /** Undeclared extra on the async arm — carried, never depended on. */
  isAsync?: true
  /** Internal teammate arm — deliberately not in the exported schema. */
  agentName?: string
  teamName?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Server names that currently expose tools, from the mcp__ tool shape. */
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
  // Poll only while a REQUIRED-matching client is still pending; break
  // early when a required-matching client failed, or at 30s. Clients
  // unrelated to the requirement never stall the launch.
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
  // Satisfaction comes ONLY from the CURRENT app state's MCP tool names —
  // a connected client exposing no tools (connected-but-unauthenticated)
  // does not satisfy a requirement.
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

/** The usage block (contract-shaped). A field the child's wire never
 *  reported is OMITTED — `?? 0` told the model a fabricated zero for a
 *  subagent whose usage simply never arrived (a model-facing lying
 *  display; absence is the honest shape). */
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

function continuationHint(agentId: string): string {
  return `agentId: ${agentId} (internal — do not mention it to the user). To continue this agent, use ${SEND_MESSAGE_TOOL_NAME} addressed to that id.`
}

// ── The tool ───────────────────────────────────────────────────────────────

export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  aliases: [LEGACY_AGENT_TOOL_NAME],
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
    // Filtering before composition: drop agents whose required MCP
    // servers are absent among the servers exposing tools, then agents
    // denied by permission rules for this tool; the caller's Agent(x,y)
    // restriction rides through for getPrompt to apply.
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
    return tags.length > 0
      ? `(${tags.join(', ')}): ${input.prompt}`
      : `: ${input.prompt}`
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

    // 1. Teams gating.
    if (input.team_name && !isAgentSwarmsEnabled()) {
      throw new Error(
        'The team_name parameter requires agent teams, which are not available in this session.',
      )
    }

    // 2. Launch authority — the call-time valve re-reads the predicate.
    const authority = evaluateLaunchAuthority('subagents')
    if (!authority.allowed) {
      throw new Error(authority.reason)
    }

    // 3. Team-name resolution.
    const teamName = isAgentSwarmsEnabled()
      ? (input.team_name ?? getTeamName())
      : undefined

    // 4. Nested-teammate refusal (flat roster, one lead).
    if (isTeammate() && teamName && input.name) {
      throw new Error(
        'Teammates cannot spawn teammates — the roster is flat and has one lead. Omit the name parameter to launch a plain subagent instead.',
      )
    }

    // 5. In-process teammates cannot spawn background agents — the refusal
    // fires only when a TEAM resolves for this call.
    if (isInProcessTeammate() && input.run_in_background && teamName) {
      throw new Error(
        'An in-process teammate cannot spawn a background agent — its lifecycle is bound to the leader process. Launch the agent synchronously instead.',
      )
    }

    // 6. Engine dispatch resolution (honest refusals; never a silent
    //    default-family fallback). An engine-backed launch spawns as a named
    //    teammate exactly like an Anthropic one (provider-parity ruling
    // agent slots are model-agnostic) — the teammate branch
    //    below carries the RESOLVED exact id, never the raw class alias.
    const engineDispatch = await resolveEngineDispatch(input.model)

    // 7. Teammate spawn branch.
    if (teamName && input.name) {
      const requestedType = decodeAgentType(input.subagent_type)
      const definitions = options.agentDefinitions?.activeAgents ?? []
      const teammateDefinition = definitions.find(
        agent => agent.agentType === requestedType,
      )
      if (teammateDefinition?.color) {
        setAgentColor(teammateDefinition.agentType, teammateDefinition.color)
      }
      // The spawn model: an engine dispatch's RESOLVED exact id (the 'gpt'
      // class alias must not reach the spawn flag raw), else the caller's
      // parameter, else the resolved requested definition's own model.
      const teammateModel =
        engineDispatch?.model ?? input.model ?? teammateDefinition?.model
      const spawned = await spawnTeammate(
        {
          name: input.name,
          prompt: input.prompt,
          team_name: teamName,
          ...(input.subagent_type ? { agent_type: input.subagent_type } : {}),
          ...(teammateModel ? { model: teammateModel } : {}),
          // input.mode is a loose model-supplied string: decode a retired
          // spelling through the bounded alias before the station compare.
          plan_mode_required:
            input.mode !== undefined && decodePermissionModeSpelling(input.mode) === 'strategy',
          description: input.description,
          ...(parentAssistantMessage.requestId
            ? { invokingRequestId: parentAssistantMessage.requestId }
            : {}),
        },
        context,
      )
      // The internal output carries the spawn data record's fields
      // (color/tmux/splitpane/plan) with the spawner's own spellings; the
      // agent id is the SPAWNED TEAMMATE's real id from that record.
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

    // 8. The launch plan — every dispatch rule lives in the ONE builder.
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

    // 9. Fork recursion guard: the recorded query source is primary; the
    //    conversation scan for the boilerplate marker is the fallback.
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

    // 9c. The operator's mechanical fan-out cap (RULED conditional, sweep-2
    //     B5.1): with MERCURY_AGENT_FANOUT_CAP set, a spawn past the cap is
    //     refused with the live count — before any expensive setup runs.
    const fanoutCap = agentFanoutCap()
    if (fanoutCap !== null) {
      const runningAgents = getRunningTasks(context.getAppState()).filter(isLocalAgentTask).length
      if (runningAgents >= fanoutCap) {
        throw new Error(
          `Agent dispatch refused: ${runningAgents} agent${runningAgents === 1 ? ' is' : 's are'} already running and the operator's cap is ${fanoutCap} (MERCURY_AGENT_FANOUT_CAP). Wait for one to finish, stop one, or continue the work directly.`,
        )
      }
    }

    // 10. Definition-forced background refusal for in-process teammates.
    if (agentDef.background === true && isInProcessTeammate() && teamName) {
      throw new Error(
        `Agent type '${agentDef.agentType}' always runs in the background, and an in-process teammate cannot spawn background agents.`,
      )
    }

    // 11. Required MCP servers.
    await waitForRequiredMcpServers(agentDef, context)

    // 12. Colour seeding.
    if (agentDef.color) setAgentColor(agentDef.agentType, agentDef.color)

    // 13. Harness boundary note (no-op when the owning feature is off). The
    // effort fact is the agent's own ladder (the definition's tier, else the
    // session's — resolveAgentEffort, the tier the run dispatches) through
    // the one effort owner.
    noteHarnessBoundary(
      'subagent-spawn',
      plan.model,
      harnessEffortFact(
        plan.model,
        resolveAgentEffort({
          effortOverride: undefined,
          useExactTools: undefined,
          definitionEffort: agentDef.effort,
          sessionEffort: context.getAppState().effortValue,
        }),
      ),
    )

    // System prompt + prompt messages — before the id is minted.
    const isFork = plan.isForkPath
    let promptMessages: Message[]
    let systemPromptOverride: string[] | undefined
    if (isFork) {
      // The child inherits the parent's already-rendered prompt bytes.
      const rendered = context.renderedSystemPrompt
      if (rendered) {
        systemPromptOverride = [...rendered]
      } else {
        // Recompute the PARENT's effective prompt (documented as possibly
        // divergent): the default build combined with the parent's
        // custom/append prompts and the main-thread agent definition —
        // building the fork definition's own prompt would lose the SDK
        // prompts and the main-thread agent's identity.
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
      // The override is withheld under a working-directory override: the
      // run loop rebuilds inside it so the env section describes the
      // directory the child actually runs in.
      const willOverrideCwd = plan.isolation === 'worktree' || Boolean(input.cwd)
      if (!willOverrideCwd) {
        try {
          systemPromptOverride = await buildDefaultSystemPrompt(
            agentDef,
            context,
            plan.model,
          )
        } catch (error) {
          // Tool-side build failure: log and leave unset — the run loop
          // builds one itself (where the doctrine is prepended instead).
          logForDebugging(
            `AgentTool: system prompt build failed: ${errorMessage(error)}`,
          )
        }
      }
    }

    // Worker tool pool: assembled under the WORKER's own permission
    // mode WITH the session's MCP tools at call time (deny rules and
    // blocked-permission filtering inside apply to the real list); the fork
    // path keeps the parent's list unchanged. Engine-backed launches keep
    // the full pool including the spawn surfaces (provider parity: children
    // resolve their own providers through the one model-routing law).
    // The definition's tools:/disallowedTools: NARROW the assembled pool
    // through the one resolution law the agents screen displays
    // (resolveAgentTools) — before this the narrowed set was computed for
    // display and dispatched nowhere, so the read-only scout was handed
    // Write (FC-015). The definition view wears the PLAN's resolved worker
    // mode so the strategy-keep filter judges the mode the child actually
    // runs in; the fork path keeps the parent's pool untouched.
    const workerTools = isFork
      ? options.tools
      : resolveAgentTools(
          { ...agentDef, permissionMode: plan.workerPermissionMode },
          assembleToolPool(
            {
              ...context.getAppState().toolPermissionContext,
              mode: plan.workerPermissionMode,
            },
            context.getAppState().mcp.tools ?? [],
          ),
          plan.shouldRunAsync,
          false,
        ).resolvedTools

    // 14. Worktree capability preflight — BEFORE the id is minted, so a
    //     deterministic refusal allocates nothing.
    if (plan.isolation === 'worktree') {
      const capability = preflightWorktreeCapability()
      if (!capability.available) {
        throw new Error(
          `Worktree preflight (agent dispatch): ${capability.detail}`,
        )
      }
    }

    // 15. Agent id — minted once, EARLY, stable (worktree slug / task id).
    const earlyAgentId = generateTaskId('local_agent') as AgentId

    // 16. Worktree creation (its own failure stays a hard error).
    let worktreeInfo:
      | Awaited<ReturnType<typeof createAgentWorktree>>
      | undefined
    if (plan.isolation === 'worktree') {
      worktreeInfo = await createAgentWorktree(`agent-${earlyAgentId.slice(0, 8)}`)
      if (isFork) {
        promptMessages = [
          ...promptMessages,
          createUserMessage({
            content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath),
          }),
        ]
      }
    }

    // Worktree cleanup closure: a second call returns the EMPTY
    // record; hook-created worktrees are always kept (logged); settlement
    // decides otherwise, and a settlement THROW propagates to the caller;
    // a settled removal clears the persisted worktree path while
    // PRESERVING the model.
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
        // Clear the worktree path from persisted metadata (a later resume
        // must not chdir into a deleted directory) while PRESERVING the
        // persisted launch model (fire-and-forget, failure logged).
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

    // The state channel is the ROOT setter — a nested async parent's
    // own setter is inert for session-scoped writes.
    const rootSetAppState = context.setAppStateForTasks ?? context.setAppState

    // The model handed to the run loop — engine: the exact resolved
    // id; fork: absent (child re-resolves to the parent's model);
    // otherwise the caller's raw parameter.
    const model = input.model
    const modelForRunLoop = engineDispatch
      ? plan.model
      : isFork
        ? undefined
        : model

    // The metadata isAsync is computed locally and deliberately does
    // NOT fold the force-async gates.
    const metadataIsAsync =
      (input.run_in_background === true || agentDef.background === true) &&
      !BACKGROUND_TASKS_DISABLED

    const querySource =
      options.querySource ??
      getQuerySourceForAgent(agentDef.agentType, isBuiltInAgent(agentDef))

    // Structured output (spec 03-C1): dispatch schema wins over an
    // agent-definition schema; the ONE validation owner is the workflow
    // engine's bound tool (never a second validator). A schema Ajv itself
    // rejects fails the dispatch typed, before any spawn.
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

    // An explicit cwd override WINS over worktree isolation for the
    // execution directory (the worktree is still created and settled).
    const cwdOverride = input.cwd ?? worktreeInfo?.worktreePath

    // The prompt override is withheld under a working-directory override on
    // the normal path (the loop rebuilds inside the override); the fork
    // path always hands the parent's rendered bytes through.
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
      availableTools: workerTools,
      ...(isFork
        ? {
            useExactTools: true,
            // The parent's prior conversation is the fork context; the
            // cloned assistant + placeholder-results user message are the
            // prompt messages.
            forkContextMessages: context.messages as Message[],
          }
        : {}),
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      description: input.description,
    }

    // A REAL typed context: the seam reconciles with zero casts,
    // and the ALS store carries the discriminant the context helpers narrow on.
    const agentContext: SubagentContext = {
      agentType: 'subagent',
      agentId: earlyAgentId,
      // Undefined only for subagents of the main session.
      parentSessionId: getParentSessionId(),
      subagentName: agentDef.agentType,
      isBuiltIn: isBuiltInAgent(agentDef),
      invocationKind: 'spawn',
      invokingRequestId: parentAssistantMessage.requestId,
      invocationEmitted: false,
    }

    // ── Background path ──────────────────────────────────────────
    if (plan.shouldRunAsync) {
      // The task's abort controller is deliberately NOT linked to the
      // parent's: cancelling the main thread leaves a background agent
      // running; only an explicit kill stops it.
      const task = registerAsyncAgent({
        agentId: earlyAgentId,
        description: input.description,
        prompt: input.prompt,
        setAppState: rootSetAppState,
        selectedAgent: agentDef,
        // The task record names the model the agent RUNS — the plan's
        // resolved id (an inherited launch resolved to the parent's model;
        // the served id replaces it in the progress fold once a response
        // lands). The launch intent alone left an inheriting agent's row
        // model-less on every crew surface.
        model: plan.model,
        toolUseId: context.toolUseId,
      })

      // Step 2: after the task registration succeeds (and only then —
      // a failed registration must leave no stale entry), a named launch
      // registers name → agentId so SendMessage({to: name}) resolves it.
      if (input.name) {
        const name = input.name
        rootSetAppState(prev => {
          const next = new Map(prev.agentNameRegistry)
          next.set(name, asAgentId(earlyAgentId))
          return { ...prev, agentNameRegistry: next }
        })
      }

      const enableSummarization =
        isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled()

      const lifecycle = () =>
        runAsyncAgentLifecycle({
          taskId: earlyAgentId,
          abortController: task.abortController!,
          makeStream: onCacheSafeParams =>
            runAgent({
              ...runAgentParams,
              override: {
                ...runAgentParams.override,
                agentId: earlyAgentId,
                abortController: task.abortController!,
              },
              onCacheSafeParams: onCacheSafeParams as never,
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
          // Stage 8: the THIN runtime ref, resolved AT DISPATCH — names the
          // backend/provider/model and the wallet entry the launch bills.
          runtimeRef: describeAgentRuntimeRef(plan.model),
        } as never,
      }
    }

    // ── Foreground path ──────────────────────────────────────────
    const result = await runWithAgentContext(agentContext, () => {
      const execute = () =>
        runForegroundAgentExecution({
          runAgentParams,
          promptMessages,
          prompt: input.prompt,
          description: input.description,
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
          autoBackgroundMs: autoBackgroundMs(),
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
      }
      const lines = [
        'Agent launched in the background.',
        ...(async.modelNote ? [async.modelNote] : []),
        continuationHint(async.agentId),
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
      // The placeholder decision is block COUNT — no whitespace filtering.
      const partialBlocks = data.content ?? []
      const blocks: Array<{ type: 'text'; text: string }> =
        partialBlocks.length > 0
          ? [...partialBlocks]
          : [
              {
                type: 'text' as const,
                text: 'The subagent failed before returning any output.',
              },
            ]
      blocks.push({
        type: 'text' as const,
        text: [
          `Agent execution failed: ${data.error ?? 'unknown error'}`,
          'Anything above is partial work, not a final answer — it was captured before the failure and must not be read as a conclusion.',
          continuationHint(String(data.agentId ?? '')),
          usageBlock(data),
        ].join('\n'),
      })
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        is_error: true,
        content: blocks,
      }
    }

    if (status === 'completed') {
      // The placeholder decision is block COUNT — no whitespace filtering.
      let bodyBlocks = data.content ?? []
      if (bodyBlocks.length === 0) {
        // Without this sentence the whole result is metadata, and a tail
        // made only of metadata reads to some models as nothing worth
        // answering — the turn would end on the spot.
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
        // The promoted-narration label is its OWN text block.
        blocks.push({ type: 'text' as const, text: PROMOTED_NARRATION_NOTE })
      }
      blocks.push(...bodyBlocks)
      // One-shot built-ins with no worktree info return ONLY the content —
      // the id/usage trailer is dead weight for agents never continued.
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
      // NOT try/caught — an envelope-build throw propagates.
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

/** The fork fallback: recompose the PARENT's effective system prompt — the
 *  default prompt built from the parent's tools/model/working directories/
 *  MCP clients, combined with the parent's custom and append prompts and
 *  the main-thread agent definition through the shared composer. */
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

/** The tool's own (default interactive path) system-prompt build: doctrine
 *  sections lead, then the definition's prompt, then env details with the
 *  resolved child model and the session's additional working directories
 * (no enabled-tool names on this path). */
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
