import { getCwdState, getSdkAgentProgressSummariesEnabled } from '../../../bootstrap/state.js'
import { enhanceSystemPromptWithEnvDetails } from '../../../constants/prompts.js'
import { agentFanoutCap, buildSubagentMercurySectionsWithOutcome, subagentMemoryLoadNote } from '../../../constants/subagentDoctrine.js'
import type { MercuryAgentSeat } from '../../../prompt/mercuryContract.js'
import { evaluateLaunchAuthority } from '../../../services/switchboard/launchAuthority.js'
import { enqueueAgentReceiptRow, registerAgentName, registerAsyncAgent, setAgentPendingAsks, setAgentWaitLine } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getRunningTasks } from '../../../utils/task/framework.js'
import { toolMatchesName, type Tool as ToolShape, type ToolUseContext } from '../../../Tool.js'
import { generateTaskId } from '../../../Task.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import { runWithAgentContext, type SubagentContext } from '../../../utils/agentContext.js'
import { getCwd, runWithCwdOverride, runWithOwnShellCwd } from '../../../utils/cwd.js'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { subagentConcurrencyCap } from '../../../utils/agentDefaults.js'
import type { CanUseToolFn } from '../../../Tool.js'
import { getQuerySourceForAgent } from '../../../utils/promptCategory.js'
import { buildAgentLaunchPlan, type AgentLaunchPlan } from '../../../services/crew/agentLaunchPlan.js'
import { getAgentModel } from '../../../services/model/agent.js'
import { MODEL_LOOKUP_LADDER } from '../../../utils/model/modelLookup.js'
import { matchReachableModelName, modelNameHeadlessRefusal } from '../../../services/model/modelNameRoad.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from '../../../services/crew/engineDispatch.js'
import { describeAgentRuntimeRef } from '../../../services/providers/primaryBackend.js'
import { getTaskOutputPath } from '../../../utils/task/diskOutput.js'
import { createAgentWorktree, preflightWorktreeCapability, unlockAgentWorktree } from '../../../services/worktree.js'
import { holdToolsUntil, releaseToolHold } from '../../../utils/worktreeReadiness.js'
import { crewWorktreeLeftoverOf, noteCrewWorktreeLeftover } from '../../../services/crew/crewWorktreeReminder.js'
import { createUserMessage } from '../../../services/messages.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { FILE_READ_TOOL_NAME } from '../../../constants/tools/fileRead.js'
import { recordCrewStart } from '../../../utils/crew/crewStart.js'
import { runForegroundAgentExecution, type ForegroundAgentMetadata } from '../foregroundExecution.js'
import { resolveWorkerTools, runAsyncAgentLifecycle } from '../agentToolUtils.js'
import { getSchemaBoundStructuredOutputTool } from '../../SyntheticOutputTool/structuredOutputTool.js'
import { buildFrozenWorktreeNotice } from '../frozenWorktreeNotice.js'
import { buildWorktreePrepareNotice } from '../worktreePrepareNotice.js'
import type { AgentDefinition } from '../../../types/agent.js'
import { isBuiltInAgent } from '../../../types/agent.js'
import { runAgent, type RunAgentParams } from '../runAgent.js'
import { reserveSwarmLaunch, watchSwarmLaunch } from '../../../services/crewBoard/seam.js'
import { setAgentColor } from '../agentColorManager.js'
import { subscribeMcpClientsChange } from '../../../state/onChangeAppState.js'
import { withDeadline } from '../../../utils/deadline.js'
import { type Progress, BACKGROUND_TASKS_DISABLED, DEFAULT_AGENT_TYPE, type AgentToolInput, type AgentToolOutput } from './schema.js'
import { resolveAgentCwd } from './cwd.js'
import { toolPoolOfTheTable } from '../../toolTable.js'
import { notBuilt } from '../../../pi/holes.js'

export function mcpServerNamesWithTools(tools: readonly ToolShape[]): string[] {
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
  const clients = () => context.getAppState().mcp.clients ?? []
  const matchesRequired = (name: string) =>
    required.some(pattern =>
      name.toLowerCase().includes(pattern.toLowerCase()),
    )
  const settled = (): boolean => {
    const current = clients()
    const pendingRequired = current.some(
      client => client.type === 'pending' && matchesRequired(client.name),
    )
    if (!pendingRequired) return true
    return current.some(
      client => client.type === 'failed' && matchesRequired(client.name),
    )
  }
  if (!settled()) {
    let unsubscribe: (() => void) | undefined
    try {
      await withDeadline(
        new Promise<void>(resolve => {
          unsubscribe = subscribeMcpClientsChange(() => {
            if (settled()) resolve()
          })
          if (settled()) resolve()
        }),
        30_000,
        () => {},
        { signal: context.abortController?.signal },
      )
    } finally {
      unsubscribe?.()
    }
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
      `Crewmate type '${definition.agentType}' requires MCP server(s) matching: ${missing.join(', ')}. ` +
        `Servers currently exposing tools: ${serversWithTools.length > 0 ? [...new Set(serversWithTools)].join(', ') : 'none'}. ` +
        'Configure the required server with the /mcp command.',
    )
  }
}

const CREWMATE_SEAT: MercuryAgentSeat = 'a crewmate'

export async function agentToolCall(
  input: AgentToolInput,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentAssistantMessage: AssistantMessage,
  onProgress?: (progress: { toolUseID: string; data: Progress }) => void,
) {
  const startTime = Date.now()
  const options = context.options

  const authority = evaluateLaunchAuthority('subagents')
  if (!authority.allowed) {
    throw new Error(authority.reason)
  }

  const typedModel = input.model
  const matchedModel = typedModel ? matchReachableModelName(typedModel, 'pass') : null
  if (matchedModel !== null && (matchedModel.kind === 'ambiguous' || matchedModel.kind === 'none')) {
    throw new Error(`${modelNameHeadlessRefusal(matchedModel, 'model')} ${MODEL_LOOKUP_LADDER}`)
  }
  const modelWord = matchedModel !== null && (matchedModel.kind === 'match' || matchedModel.kind === 'exact') ? matchedModel.id : typedModel
  const modelParam = modelWord ? getAgentModel(undefined, options.engineModel, modelWord) : modelWord
  const engineDispatch = await resolveEngineDispatch(modelParam)
  if (engineDispatch === null) {
    const unrecognised = unrecognisedModelWordRefusal(modelWord)
    if (unrecognised !== null) throw new Error(unrecognised)
  }

  const cwdParam = input.cwd !== undefined ? resolveAgentCwd(input.cwd, context.getAppState().toolPermissionContext, { admit: true }) : undefined

  const activeAgents = options.agentDefinitions?.activeAgents ?? []
  const allowedAgentTypes = options.agentDefinitions?.allowedAgentTypes
  const plan = buildAgentLaunchPlan({
    requestedType: input.crewmate_type,
    activeAgents,
    allowedAgentTypes,
    toolPermissionContext: context.getAppState().toolPermissionContext,
    defaultAgentType: DEFAULT_AGENT_TYPE,
    engineModel: options.engineModel,
    modelParam: engineDispatch ? undefined : modelWord,
    resolvedModel: modelParam || undefined,
    permissionMode: context.getAppState().toolPermissionContext.mode,
    isolationParam: input.isolation,
    runInBackground: input.run_in_background,
    backgroundTasksDisabled: BACKGROUND_TASKS_DISABLED,
    forceAsync: false,
    ...(engineDispatch
      ? {
          engineDispatch: {
            backend: engineDispatch.backend,
            model: engineDispatch.model,
            ...(engineDispatch.note !== undefined ? { note: engineDispatch.note } : {}),
          },
        }
      : {}),
  })
  const agentDef = plan.definition

  const fanout = subagentConcurrencyCap(agentFanoutCap())
  const runningAgents = getRunningTasks(context.getAppState()).filter(isLocalAgentTask).length
  if (runningAgents >= fanout.cap) {
    const door = fanout.source === 'env' ? 'MERCURY_AGENT_FANOUT_CAP' : 'Crewmates at once in /config'
    throw new Error(
      `Crewmate dispatch refused: ${runningAgents} crewmate${runningAgents === 1 ? ' is' : 's are'} already running and the cap is ${fanout.cap} (${door}). Wait for one to finish, stop one, or continue the work directly.`,
    )
  }

  await waitForRequiredMcpServers(agentDef, context)

  if (agentDef.color) setAgentColor(agentDef.agentType, agentDef.color)

  let promptMessages: Message[] = [createUserMessage({ content: input.prompt })]
  let systemPromptOverride: string[] | undefined

  const workerTools = resolveWorkerTools(
        agentDef,
        plan.workerPermissionMode,
        toolPoolOfTheTable(
          {
            ...context.getAppState().toolPermissionContext,
            mode: plan.workerPermissionMode,
          },
          context.getAppState().mcp.tools ?? [],
        ),
      )

  if (input.review_receipt !== undefined && (!input.worktree_at || plan.isolation !== 'worktree' || input.cwd !== undefined)) {
    throw new Error('review_receipt requires worktree_at with worktree isolation, without a cwd override: a review reads a frozen worktree and writes one receipt.')
  }

  if (plan.isolation === 'worktree') {
    const capability = preflightWorktreeCapability(cwdParam)
    if (!capability.available) {
      throw new Error(
        `Worktree preflight (crewmate dispatch): ${capability.detail}`,
      )
    }
  }

  const earlyAgentId = generateTaskId('local_agent') as AgentId
  const releaseEnrollment = reserveSwarmLaunch(earlyAgentId, input, context.agentId ?? 'main')
  let backgroundOwnsEnrollment = false
  try {
  const willOverrideCwd = plan.isolation === 'worktree' || cwdParam !== undefined
  let memoryLoadNote: string | undefined
  if (!willOverrideCwd) {
    try {
      const built = await buildDefaultSystemPrompt(
        agentDef,
        context,
        plan.model,
        earlyAgentId,
        new Set(workerTools.map(tool => tool.name)),
        CREWMATE_SEAT,
      )
      systemPromptOverride = built.prompt
      if (built.memoryLoadError !== undefined) {
        memoryLoadNote = subagentMemoryLoadNote(built.memoryLoadError)
      }
    } catch (error) {
      logForDebugging(
        `AgentTool: system prompt build failed: ${errorMessage(error)}`,
      )
    }
  }
  let worktreeInfo:
    | Awaited<ReturnType<typeof createAgentWorktree>>
    | undefined
  if (plan.isolation === 'worktree') {
    worktreeInfo = await createAgentWorktree(`agent-${earlyAgentId.slice(0, 8)}`, {
      ...(input.worktree_at !== undefined ? { at: input.worktree_at } : undefined),
      ...(cwdParam !== undefined ? { from: cwdParam } : {}),
      foldersBehindLaunch: true,
      permission: context.getAppState().toolPermissionContext,
    })
    if (worktreeInfo.ready !== undefined) holdToolsUntil(earlyAgentId, worktreeInfo.ready)
    if (input.worktree_at !== undefined && worktreeInfo.headCommit !== undefined) {
      promptMessages = [
        ...promptMessages,
        createUserMessage({
          content: buildFrozenWorktreeNotice(worktreeInfo.worktreePath, worktreeInfo.headCommit),
        }),
      ]
    }
    if (worktreeInfo.prepareFailure !== undefined) {
      promptMessages = [
        ...promptMessages,
        createUserMessage({ content: buildWorktreePrepareNotice(worktreeInfo.prepareFailure) }),
      ]
    }
  } else if (input.worktree_at !== undefined) {
    throw new Error("worktree_at needs isolation: 'worktree' — the pin names the commit a temporary worktree stands at.")
  }
  recordCrewStart(earlyAgentId, {
    name: input.name ?? input.description,
    cwd: cwdParam ?? getCwd(),
    worktree: worktreeInfo?.worktreePath ?? null,
    model: plan.model,
  })

  let cleanupDone = false
  const cleanupWorktreeIfNeeded = async (): Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }> => {
    if (cleanupDone || !worktreeInfo) return {}
    cleanupDone = true
    releaseToolHold(earlyAgentId)
    await worktreeInfo.ready
    try {
      if (worktreeInfo.gitRoot !== undefined) await unlockAgentWorktree(worktreeInfo.worktreePath, worktreeInfo.gitRoot)
      const leftover = await crewWorktreeLeftoverOf(
        {
          name: input.name ?? input.description,
          path: worktreeInfo.worktreePath,
          ...(worktreeInfo.worktreeBranch !== undefined ? { branch: worktreeInfo.worktreeBranch } : {}),
          ...(worktreeInfo.gitRoot !== undefined ? { gitRoot: worktreeInfo.gitRoot } : {}),
        },
        Date.now(),
      )
      noteCrewWorktreeLeftover(leftover)
      logForDebugging(`AgentTool: worktree kept (${leftover.state}): ${leftover.detail}`)
    } catch (error) {
      logForDebugging(`AgentTool: the worktree's leftover could not be read: ${errorMessage(error)}`)
    }
    return {
      worktreePath: worktreeInfo.worktreePath,
      ...(worktreeInfo.worktreeBranch
        ? { worktreeBranch: worktreeInfo.worktreeBranch }
        : {}),
    }
  }

  const rootSetAppState = context.setAppStateForTasks ?? context.setAppState

  const model = modelWord
  const modelForRunLoop = engineDispatch ? plan.model : model

  const metadataIsAsync =
    (input.run_in_background === true || agentDef.background === true) &&
    !BACKGROUND_TASKS_DISABLED

  const querySource = getQuerySourceForAgent(agentDef.agentType, isBuiltInAgent(agentDef))

  const definitionSchema = (agentDef as { outputSchema?: Record<string, unknown> }).outputSchema
  const structuredOutputSpec = structuredOutputSpecOf(input, definitionSchema)

  const metadata = metadataOf(input, plan, agentDef, startTime, metadataIsAsync, structuredOutputSpec)

  const cwdOverride = worktreeInfo?.worktreePath ?? cwdParam
  const launchDirectory = cwdParam ?? (getCwd() !== getCwdState() ? getCwd() : undefined)

  const effectiveSystemPromptOverride = cwdOverride ? undefined : systemPromptOverride

  const runAgentParams = runAgentParamsOf({ agentDef, promptMessages, context, canUseTool, plan, querySource, structuredOutputSpec, effectiveSystemPromptOverride, modelForRunLoop, input, workerTools, worktreeInfo, launchDirectory, startTime, earlyAgentId, rootSetAppState })

  const agentContext = agentContextOf(earlyAgentId, agentDef, parentAssistantMessage)

  const launchModelNote = [plan.modelNote, memoryLoadNote].filter(Boolean).join('\n') || undefined

  if (plan.shouldRunAsync) {
    const lifecycle = asyncLifecycleOf({ earlyAgentId, input, rootSetAppState, agentDef, plan, context, runAgentParams, metadata, cleanupWorktreeIfNeeded, canUseTool })

    backgroundOwnsEnrollment = true
    void runWithAgentContext(agentContext, () =>
      cwdOverride
        ? runWithCwdOverride(cwdOverride, lifecycle)
        : runWithOwnShellCwd(lifecycle),
    ).finally(releaseEnrollment)

    return asyncLaunchAnswerOf(options, earlyAgentId, input, plan, agentDef, launchModelNote)
  }

  const result = await runWithAgentContext(agentContext, () => {
    const execute = () =>
      runForegroundAgentExecution({
        runAgentParams,
        promptMessages,
        prompt: input.prompt,
        description: input.description,
        name: input.name,
        ...(launchModelNote ? { modelNote: launchModelNote } : {}),
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
      : runWithOwnShellCwd(execute)
  })

  if (result.detached !== undefined) {
    backgroundOwnsEnrollment = true
    void result.detached.finally(releaseEnrollment)
  }
  if (memoryLoadNote !== undefined && result.data.status !== 'async_launched') {
    enqueueAgentReceiptRow({
      taskId: earlyAgentId,
      description: input.description,
      status: result.data.status === 'failed' ? 'failed' : 'completed',
      summary: memoryLoadNote,
    })
  }
  return { data: result.data }
  } finally {
    if (!backgroundOwnsEnrollment) releaseEnrollment()
  }
}

function structuredOutputSpecOf(input: AgentToolInput, definitionSchema: Record<string, unknown> | undefined) {
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
}

function metadataOf(input: AgentToolInput, plan: AgentLaunchPlan, agentDef: AgentDefinition, startTime: number, metadataIsAsync: boolean, structuredOutputSpec: ReturnType<typeof structuredOutputSpecOf>): ForegroundAgentMetadata {
  return {
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
}

function runAgentParamsOf(arg0: {
  agentDef: AgentDefinition; promptMessages: Message[]; context: ToolUseContext; canUseTool: CanUseToolFn; plan: AgentLaunchPlan; querySource: ReturnType<typeof getQuerySourceForAgent>
  structuredOutputSpec: ReturnType<typeof structuredOutputSpecOf>; effectiveSystemPromptOverride: string[] | undefined; modelForRunLoop: string | undefined; input: AgentToolInput
  workerTools: ReturnType<typeof resolveWorkerTools>; worktreeInfo: Awaited<ReturnType<typeof createAgentWorktree>> | undefined; launchDirectory: string | undefined
  startTime: number; earlyAgentId: AgentId; rootSetAppState: ToolUseContext['setAppState']
}): RunAgentParams {
  return notBuilt('src/tools/AgentTool/agent/call.ts:423')
}

function agentContextOf(earlyAgentId: AgentId, agentDef: AgentDefinition, parentAssistantMessage: AssistantMessage): SubagentContext {
  return {
    agentType: 'subagent',
    agentId: earlyAgentId,
    subagentName: agentDef.agentType,
    isBuiltIn: isBuiltInAgent(agentDef),
    invocationKind: 'spawn',
    invokingRequestId: parentAssistantMessage.requestId,
    invocationEmitted: false,
  }
}

function asyncLifecycleOf({ earlyAgentId, input, rootSetAppState, agentDef, plan, context, runAgentParams, metadata, cleanupWorktreeIfNeeded, canUseTool }: {
  earlyAgentId: AgentId; input: AgentToolInput; rootSetAppState: ToolUseContext['setAppState']; agentDef: AgentDefinition; plan: AgentLaunchPlan; context: ToolUseContext
  runAgentParams: RunAgentParams; metadata: ForegroundAgentMetadata; cleanupWorktreeIfNeeded: () => Promise<{ worktreePath?: string; worktreeBranch?: string }>; canUseTool: CanUseToolFn
}) {
  const task = registerAsyncAgent({
    agentId: earlyAgentId,
    description: input.description,
    prompt: input.prompt,
    setAppState: rootSetAppState,
    selectedAgent: agentDef,
    model: plan.model,
    toolUseId: context.toolUseId,
  })
  watchSwarmLaunch(earlyAgentId, task.abortController!.signal)

  if (input.name) registerAgentName(input.name, earlyAgentId, rootSetAppState)

  const enableSummarization = getSdkAgentProgressSummariesEnabled()

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
          onCacheSafeParams,
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
  return lifecycle
}

function asyncLaunchAnswerOf(options: ToolUseContext['options'], earlyAgentId: AgentId, input: AgentToolInput, plan: AgentLaunchPlan, agentDef: AgentDefinition, modelNote?: string): { data: AgentToolOutput } {
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
      ...(modelNote ? { modelNote } : {}),
      ...(input.name ? { agentName: input.name } : {}),
      ...(input.run_in_background === false && agentDef.background === true
        ? { backgroundReason: 'agent-type' as const }
        : {}),
      runtimeRef: describeAgentRuntimeRef(plan.model),
    },
  }
}

async function buildDefaultSystemPrompt(
  definition: AgentDefinition,
  context: ToolUseContext,
  childModel: string,
  agentId: AgentId,
  toolNames: ReadonlySet<string>,
  seat: MercuryAgentSeat,
): Promise<{ prompt: string[]; memoryLoadError?: string }> {
  const ownPrompt = isBuiltInAgent(definition)
    ? definition.getSystemPrompt({ toolUseContext: context })
    : definition.getSystemPrompt()
  const doctrine = buildSubagentMercurySectionsWithOutcome({
    agentDefinition: definition,
    toolUseContext: context,
    toolNames,
    seat,
  })
  const prompt = await enhanceSystemPromptWithEnvDetails(
    [...doctrine.sections, ownPrompt],
    childModel,
    undefined,
    agentId,
  )
  return doctrine.memoryLoadError !== undefined ? { prompt, memoryLoadError: doctrine.memoryLoadError } : { prompt }
}
