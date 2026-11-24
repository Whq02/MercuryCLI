import { getCwdState } from '../../../boot/process-state/processState.js'
import { enhanceSystemPromptWithEnvDetails } from '../../../engine/system-prompt/defaultSystemPrompt.js'
import { crewmateFanoutCap, buildCrewmateMercurySectionsWithOutcome, crewmateMemoryLoadNote } from '../subagentDoctrine.js'
import type { MercuryCrewmateSeat } from '../../../engine/system-prompt/mercuryContract.js'
import { evaluateLaunchAuthority } from '../../../daemon/switchboard/launchAuthority.js'
import { enqueueCrewmateReceiptRow, registerCrewmateName, registerAsyncCrewmate, setCrewmatePendingAsks, setCrewmateWaitLine } from '../../../engine/tasks/local-agent/crewmateTask.js'
import { isCrewmateTask } from '../../../engine/tasks/local-agent/crewmateTask.js'
import { getRunningTasks } from '../../../engine/task-framework/taskRegistry.js'
import { toolMatchesName, type Tool as ToolShape, type ToolUseContext } from '../../kit/tool.js'
import { generateTaskId } from '../../../engine/tasks/taskBase.js'
import type { AssistantMessage, Message } from '../../../engine/message-shapes/message.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import { runWithCrewmateContext, type CrewmateContext } from '../../../crew/agents/agentContext.js'
import { getCwd, runWithCwdOverride, runWithOwnShellCwd } from '../../../platform/files/cwd.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { crewmateConcurrencyCap } from '../../../crew/agents/agentDefaults.js'
import type { CanUseToolFn } from '../../kit/tool.js'
import { getQuerySourceForAgent } from '../promptCategory.js'
import { buildCrewmateLaunchPlan, type CrewmateLaunchPlan } from '../../../crew/crewmates/agentLaunchPlan.js'
import { getCrewmateModel } from '../../../models/catalogue/agentModel.js'
import { MODEL_LOOKUP_LADDER } from '../../../models/facts/modelLookup.js'
import { matchReachableModelName, modelNameHeadlessRefusal } from '../../../models/catalogue/modelNameRoad.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from '../../../crew/crewmates/engineDispatch.js'
import { describeAgentRuntimeRef } from '../../../models/roads/primaryBackend.js'
import { getTaskOutputPath } from '../../../engine/task-framework/diskOutput.js'
import { createCrewmateWorktree, preflightWorktreeCapability, unlockCrewmateWorktree } from '../../../platform/git/worktree/worktree.js'
import { holdToolsUntil, releaseToolHold } from '../run/worktreeReadiness.js'
import { crewWorktreeLeftoverOf, noteCrewWorktreeLeftover } from '../../../crew/crewmates/crewWorktreeReminder.js'
import { createUserMessage } from '../../../engine/messages/messages.js'
import { BASH_TOOL_NAME } from '../../kit/names/bash.js'
import { READ_TOOL_NAME } from '../../kit/names/fileRead.js'
import { recordCrewStart } from '../../../crew/crew-start/crewStart.js'
import { runForegroundCrewmateExecution, type ForegroundCrewmateMetadata } from '../foregroundExecution.js'
import { resolveCrewmateTools, runAsyncCrewmateLifecycle } from '../crewmateLifecycle.js'
import { createSyntheticOutputTool } from '../../structured-output/SyntheticOutputTool.js'
import { buildFrozenWorktreeNotice } from '../frozenWorktreeNotice.js'
import { buildWorktreePrepareNotice } from '../worktreePrepareNotice.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { isBuiltInAgent } from '../../../crew/agents/agentDefinition.js'
import { runCrewmate, type RunCrewmateParams } from '../runCrewmate.js'
import { reserveSwarmLaunch, watchSwarmLaunch } from '../../../crew/board/seam.js'
import { setAgentColor } from '../crewmateColors.js'
import { subscribeMcpClientsChange } from '../../../screen/app-state/onChangeAppState.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { type Progress, BACKGROUND_TASKS_DISABLED, DEFAULT_AGENT_TYPE, type CrewmateToolInput, type CrewmateToolOutput } from './schema.js'
import { resolveCrewmateCwd } from './cwd.js'
import { toolPoolOfTheTable } from '../../kit/toolTable.js'

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

const CREWMATE_SEAT: MercuryCrewmateSeat = 'a crewmate'

export async function crewmateToolCall(
  input: CrewmateToolInput,
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
  const modelParam = modelWord ? getCrewmateModel(undefined, options.engineModel, modelWord) : modelWord
  const engineDispatch = await resolveEngineDispatch(modelParam)
  if (engineDispatch === null) {
    const unrecognised = unrecognisedModelWordRefusal(modelWord)
    if (unrecognised !== null) throw new Error(unrecognised)
  }

  const cwdParam = input.cwd !== undefined ? resolveCrewmateCwd(input.cwd, context.getAppState().toolPermissionContext, { admit: true }) : undefined

  const activeAgents = options.agentDefinitions?.activeAgents ?? []
  const allowedAgentTypes = options.agentDefinitions?.allowedAgentTypes
  const plan = buildCrewmateLaunchPlan({
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

  const fanout = crewmateConcurrencyCap(crewmateFanoutCap())
  const runningAgents = getRunningTasks(context.getAppState()).filter(isCrewmateTask).length
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

  const workerTools = resolveCrewmateTools(
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
        memoryLoadNote = crewmateMemoryLoadNote(built.memoryLoadError)
      }
    } catch (error) {
      logForDebugging(
        `AgentTool: system prompt build failed: ${errorMessage(error)}`,
      )
    }
  }
  let worktreeInfo:
    | Awaited<ReturnType<typeof createCrewmateWorktree>>
    | undefined
  if (plan.isolation === 'worktree') {
    worktreeInfo = await createCrewmateWorktree(`agent-${earlyAgentId.slice(0, 8)}`, {
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
      if (worktreeInfo.gitRoot !== undefined) await unlockCrewmateWorktree(worktreeInfo.worktreePath, worktreeInfo.gitRoot)
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

  const runAgentParams = runCrewmateParamsOf({ agentDef, promptMessages, context, canUseTool, plan, querySource, structuredOutputSpec, effectiveSystemPromptOverride, modelForRunLoop, input, workerTools, worktreeInfo, launchDirectory, startTime, earlyAgentId, rootSetAppState })

  const agentContext = crewmateContextOf(earlyAgentId, agentDef, parentAssistantMessage)

  const launchModelNote = [plan.modelNote, memoryLoadNote].filter(Boolean).join('\n') || undefined

  if (plan.shouldRunAsync) {
    const lifecycle = asyncLifecycleOf({ earlyAgentId, input, rootSetAppState, agentDef, plan, context, runAgentParams, metadata, cleanupWorktreeIfNeeded, canUseTool })

    backgroundOwnsEnrollment = true
    void runWithCrewmateContext(agentContext, () =>
      cwdOverride
        ? runWithCwdOverride(cwdOverride, lifecycle)
        : runWithOwnShellCwd(lifecycle),
    ).finally(releaseEnrollment)

    return asyncLaunchAnswerOf(options, earlyAgentId, input, plan, agentDef, launchModelNote)
  }

  const result = await runWithCrewmateContext(agentContext, () => {
    const execute = () =>
      runForegroundCrewmateExecution({
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
    enqueueCrewmateReceiptRow({
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

function structuredOutputSpecOf(input: CrewmateToolInput, definitionSchema: Record<string, unknown> | undefined) {
  const schema = input.output_schema ?? definitionSchema
  if (schema === undefined) return undefined
  const bound = createSyntheticOutputTool(schema)
  if (!bound.ok) {
    throw new Error(`output_schema is not a valid JSON Schema: ${bound.error}`)
  }
  return {
    schema,
    mode: input.schema_mode ?? ('permissive' as const),
    source: input.output_schema !== undefined ? ('dispatch' as const) : ('agent-definition' as const),
  }
}

function metadataOf(input: CrewmateToolInput, plan: CrewmateLaunchPlan, agentDef: AgentDefinition, startTime: number, metadataIsAsync: boolean, structuredOutputSpec: ReturnType<typeof structuredOutputSpecOf>): ForegroundCrewmateMetadata {
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

function runCrewmateParamsOf({ agentDef, promptMessages, context, canUseTool, plan, querySource, structuredOutputSpec, effectiveSystemPromptOverride, modelForRunLoop, input, workerTools, worktreeInfo, launchDirectory, startTime, earlyAgentId, rootSetAppState }: {
  agentDef: AgentDefinition; promptMessages: Message[]; context: ToolUseContext; canUseTool: CanUseToolFn; plan: CrewmateLaunchPlan; querySource: ReturnType<typeof getQuerySourceForAgent>
  structuredOutputSpec: ReturnType<typeof structuredOutputSpecOf>; effectiveSystemPromptOverride: string[] | undefined; modelForRunLoop: string | undefined; input: CrewmateToolInput
  workerTools: ReturnType<typeof resolveCrewmateTools>; worktreeInfo: Awaited<ReturnType<typeof createCrewmateWorktree>> | undefined; launchDirectory: string | undefined
  startTime: number; earlyAgentId: AgentId; rootSetAppState: ToolUseContext['setAppState']
}): RunCrewmateParams {
  return {
    agentDefinition: agentDef,
    seat: CREWMATE_SEAT,
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
    ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
    ...(worktreeInfo === undefined && launchDirectory !== undefined ? { cwd: launchDirectory } : {}),
    ...(input.review_receipt !== undefined ? { reviewReceipt: input.review_receipt } : {}),
    description: input.description,
    ...(input.name ? { name: input.name } : {}),
    ...(input.team ? { team: input.team } : {}),
    ...(input.captain !== undefined ? { captain: input.captain } : {}),
    launchedAt: startTime,
    onWait: line => setCrewmateWaitLine(earlyAgentId, line, rootSetAppState),
    onPendingAsks: count => setCrewmatePendingAsks(earlyAgentId, count, rootSetAppState),
  }
}

function crewmateContextOf(earlyAgentId: AgentId, agentDef: AgentDefinition, parentAssistantMessage: AssistantMessage): CrewmateContext {
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
  earlyAgentId: AgentId; input: CrewmateToolInput; rootSetAppState: ToolUseContext['setAppState']; agentDef: AgentDefinition; plan: CrewmateLaunchPlan; context: ToolUseContext
  runAgentParams: RunCrewmateParams; metadata: ForegroundCrewmateMetadata; cleanupWorktreeIfNeeded: () => Promise<{ worktreePath?: string; worktreeBranch?: string }>; canUseTool: CanUseToolFn
}) {
  const task = registerAsyncCrewmate({
    agentId: earlyAgentId,
    description: input.description,
    prompt: input.prompt,
    setAppState: rootSetAppState,
    selectedAgent: agentDef,
    model: plan.model,
    toolUseId: context.toolUseId,
  })
  watchSwarmLaunch(earlyAgentId, task.abortController!.signal)

  if (input.name) registerCrewmateName(input.name, earlyAgentId, rootSetAppState)

  const lifecycle = () =>
    runAsyncCrewmateLifecycle({
      taskId: earlyAgentId,
      abortController: task.abortController!,
      makeStream: onQueryProgress =>
        runCrewmate({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: earlyAgentId,
            abortController: task.abortController!,
          },
          ...(onQueryProgress !== undefined ? { onQueryProgress } : {}),
        }),
      metadata,
      description: input.description,
      toolUseContext: context,
      rootSetAppState,
      agentIdForCleanup: earlyAgentId,
      getWorktreeResult: cleanupWorktreeIfNeeded,
      canUseTool,
    })
  return lifecycle
}

function asyncLaunchAnswerOf(options: ToolUseContext['options'], earlyAgentId: AgentId, input: CrewmateToolInput, plan: CrewmateLaunchPlan, agentDef: AgentDefinition, modelNote?: string): { data: CrewmateToolOutput } {
  const canReadOutputFile = options.tools.some(
    tool =>
      toolMatchesName(tool, READ_TOOL_NAME) ||
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
  seat: MercuryCrewmateSeat,
): Promise<{ prompt: string[]; memoryLoadError?: string }> {
  const ownPrompt = isBuiltInAgent(definition)
    ? definition.getSystemPrompt({ toolUseContext: context })
    : definition.getSystemPrompt()
  const doctrine = buildCrewmateMercurySectionsWithOutcome({
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
