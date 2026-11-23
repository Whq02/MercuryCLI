import { rebuildSeenLinesFromTranscript } from '../../services/changeTransaction/seenLines.js'
import { processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { stat, utimes } from 'node:fs/promises'
import { getEngineModel } from '../../services/model/model.js'
import { getAgentModel } from '../../services/model/agent.js'
import { crewmateModelOverride } from '../../services/crew/crewmateModelWord.js'
import { recordAfterResume } from '../../services/crew/crewmateRecord.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { CanUseToolFn, ToolUseContext } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import { latchSwarmAgent, settleSwarmAgent, swarmResumeAdmitted } from '../../services/crewBoard/seam.js'
import {
  failAgentTask,
  isLocalAgentTask,
  registerAsyncAgent,
  setAgentWaitLine,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { recordedDescription } from '../../tasks/LocalAgentTask/launchReceipts.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
} from '../../services/messages.js'
import { settleToolUsesOfEndedRun } from '../../services/messages/apiFilters.js'
import { createUserMessage } from '../../services/messages.js'
import { createAttachmentMessage } from '../../services/attachments/orchestrator.js'
import { errorMessage } from '../../utils/errors.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { recordedRequestContexts, restoreBoundPrefixFromMessages } from '../../services/providers/anthropic/boundPrefixRecord.js'
import { pendingToolRosterRestore } from '../../services/providers/toolEconomy.js'
import { getSchemaBoundStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/structuredOutputTool.js'
import { getCwdState, getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { automaticResumePending, cancelAutomaticResume, resolveWorkerTools, runAsyncAgentLifecycle } from './agentToolUtils.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../constants/tools/agent.js'
import type { AgentDefinition } from '../../types/agent.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from '../../types/agent.js'
import { runAgent } from './runAgent.js'
import { continuationDirectoryNote } from './continuationNote.js'
import { EFFORT_LEVELS, isEffortLevel, resolveStampedEffortTruth, type EffortLevel } from '../../utils/effort.js'
import { liveAgentOwner } from './liveAgentOwner.js'
import { passedOver } from '../../utils/passedOver.js'

export { liveAgentOwner }

type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  cwdFallback?: 'parent-checkout' | 'parent-directory'
  recordedCwd?: string
  note?: string
}

const RESUMED_AGENT_DESCRIPTION = 'Resumed crewmate'

export class BoardResumeDirectoryError extends Error {
  constructor(readonly directory: string, readonly kind: 'worktree' | 'directory') {
    super(`The recorded ${kind} is unavailable: ${directory}.`)
  }
}

export function definitionForStoredType(
  storedType: string | undefined,
  activeAgents: readonly AgentDefinition[],
): AgentDefinition {
  return (
    activeAgents.find(agent => agent.agentType === storedType) ??
    activeAgents.find(agent => agent.agentType === MERCURY_CREW_AGENT_TYPE) ??
    activeAgents[0]!
  )
}

export function boardResumeRefusal(agentId: string, tasks: Record<string, unknown> | undefined): string | null {
  if (operatorPauseGate.holds('main') || operatorPauseGate.holds(agentId)) return 'The operator pause is still in force.'
  const owner = liveAgentOwner(agentId, tasks)
  if (owner !== null) return owner.words
  const task = tasks?.[agentId]
  if (isLocalAgentTask(task) && (task.status === 'pending' || task.status === 'killed' || task.stopReason !== undefined || task.paused !== undefined)) return 'The crewmate is held; the lead can resume it.'
  if (automaticResumePending(agentId)) return 'The provider recovery already holds this crewmate.'
  return null
}

export class AgentNotRecorded extends Error {}

async function existingDirectory(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  try {
    return (await stat(path)).isDirectory() ? path : undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function restoreStructuredOutputSpec(
  stored:
    | {
        schema: Record<string, unknown>
        mode: 'permissive' | 'strict'
        source: 'dispatch' | 'agent-definition'
      }
    | undefined,
):
  | {
      schema: Record<string, unknown>
      mode: 'permissive' | 'strict'
      source: 'dispatch' | 'agent-definition'
    }
  | undefined {
  let spec = stored
  if (spec === undefined) {
    const restore = pendingToolRosterRestore()
    const mark = restore?.marks.find(entry => entry.name === STRUCTURED_OUTPUT_TOOL_NAME)
    if (mark?.definition !== undefined) {
      try {
        const parsed = JSON.parse(mark.definition) as { input_schema?: unknown } | null
        if (
          parsed !== null &&
          typeof parsed.input_schema === 'object' &&
          parsed.input_schema !== null &&
          !Array.isArray(parsed.input_schema)
        ) {
          spec = {
            schema: parsed.input_schema as Record<string, unknown>,
            mode: 'permissive',
            source: 'dispatch',
          }
        }
      } catch (error) {
        passedOver(error)
      }
    }
  }
  if (spec !== undefined) {
    const bound = getSchemaBoundStructuredOutputTool(spec.schema)
    if (bound.error !== undefined) {
      throw new Error(`output_schema is not a valid JSON Schema: ${bound.error}`)
    }
  }
  return spec
}

export async function resumeAgentBackground(args: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool?: CanUseToolFn
  invokingRequestId?: string
  replyTarget?: 'parent' | 'operator'
  model?: string
  effort?: EffortLevel
  automatic?: boolean
  boardEventIds?: string[]
  onAdmitted?: () => void
}): Promise<ResumeAgentResult> {
  const { agentId, prompt, toolUseContext } = args
  const typedAgentId = agentId as AgentId
  const [transcript, meta] = await Promise.all([
    getAgentTranscript(typedAgentId),
    readAgentMetadata(typedAgentId),
  ])
  if (!transcript || transcript.messages.length === 0) {
    throw new AgentNotRecorded(`No transcript found for crewmate ${agentId}`)
  }

  const { activeAgents } = await getAgentDefinitionsWithOverrides(getCwdState())
  const selectedAgent = definitionForStoredType(meta?.agentType, activeAgents)
  const parentModel = toolUseContext.options.engineModel ?? getEngineModel()
  const restoredModel =
    args.model !== undefined
      ? await crewmateModelOverride(args.model, parentModel)
      : meta?.model
  const lifecycleModel = getAgentModel(selectedAgent.model, parentModel, restoredModel)
  const storedEffort =
    meta?.effortOverride !== undefined && isEffortLevel(meta.effortOverride)
      ? meta.effortOverride
      : meta?.effort !== undefined && isEffortLevel(meta.effort)
        ? meta.effort
        : undefined
  const restoredEffort = args.effort ?? storedEffort

  if (args.effort !== undefined) {
    const selectable = resolveStampedEffortTruth(lifecycleModel, args.effort, {
      thinkingEnabled: true,
    }).selectable
    if (args.effort !== 'max' && !selectable.includes(args.effort)) {
      throw new Error(
        `Effort '${args.effort}' is not served by ${lifecycleModel}; available: ${selectable.length > 0 ? selectable.join(' | ') : 'no effort control'}. The ladder is ${EFFORT_LEVELS.join(' | ')}. Max is admitted; no lower tier was substituted. Read mercury://models for the model's choices.`,
      )
    }
  }

  const boundKey = restoreBoundPrefixFromMessages(transcript.messages, { rosterOnly: true })
  const restoredContexts =
    boundKey !== null ? recordedRequestContexts(transcript.messages, boundKey) : null
  try {
    rebuildSeenLinesFromTranscript(processOwnerForLane(agentId), transcript.messages)
  } catch (error) {
    logForDebugging(
      `resumeAgent: failed to rebuild seen-lines ledger for ${agentId}: ${errorMessage(error)}`,
    )
  }
  const structuredOutputSpec = restoreStructuredOutputSpec(meta?.structuredOutputSpec)
  const cleaned: Message[] = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(settleToolUsesOfEndedRun(transcript.messages)),
  )
  const contentReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    cleaned,
    transcript.contentReplacements,
  )

  const worktreePath = await existingDirectory(meta?.worktreePath)
  if (worktreePath !== undefined) {
    const now = new Date()
    await utimes(worktreePath, now, now).catch(passedOver)
  }
  const cwdPath = await existingDirectory(meta?.cwd)
  const isBoardResume = args.boardEventIds !== undefined
  if (isBoardResume) {
    if (meta?.worktreePath && worktreePath === undefined) {
      throw new BoardResumeDirectoryError(meta.worktreePath, 'worktree')
    }
    if (meta?.cwd && cwdPath === undefined) {
      throw new BoardResumeDirectoryError(meta.cwd, 'directory')
    }
  }
  const directoryFacts: {
    cwdFallback?: 'parent-checkout' | 'parent-directory'
    recordedCwd?: string
  } =
    !isBoardResume && meta?.worktreePath && worktreePath === undefined
      ? { cwdFallback: 'parent-checkout', recordedCwd: meta.worktreePath }
      : !isBoardResume && meta?.cwd && cwdPath === undefined
        ? { cwdFallback: 'parent-directory', recordedCwd: meta.cwd }
        : {}
  const directoryNote = continuationDirectoryNote(directoryFacts)
  const continuationMessage: Message = isBoardResume
    ? createAttachmentMessage({
        type: 'queued_command',
        prompt,
        boardEventIds: args.boardEventIds,
        origin: { kind: 'coordinator' },
        isMeta: true,
      })
    : createUserMessage({ content: prompt })
  const promptMessages: Message[] = [...cleaned, continuationMessage]

  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const tasks = toolUseContext.getAppState().tasks
  const owner = liveAgentOwner(agentId, tasks)
  if (owner !== null) {
    throw new Error(owner.words)
  }
  if (isBoardResume) {
    if (args.automatic !== true || args.canUseTool === undefined) {
      throw new Error("A board resume needs the lead's guarded resume context.")
    }
    const refusal = boardResumeRefusal(agentId, tasks)
    if (refusal !== null) {
      throw new Error(refusal)
    }
  }
  toolUseContext.abortController.signal.throwIfAborted()
  if (args.automatic !== true) {
    cancelAutomaticResume(agentId)
    operatorPauseGate.lift(agentId)
  }

  const existingTask = tasks?.[agentId]
  const previousTask = isLocalAgentTask(existingTask) ? existingTask : undefined
  const description =
    recordedDescription(meta?.description) ||
    recordedDescription(previousTask?.description) ||
    RESUMED_AGENT_DESCRIPTION
  const replyTarget = args.replyTarget ?? previousTask?.replyTarget
  const compactRequested =
    meta?.compactOnResume === true || previousTask?.compactRequested === true
      ? (true as const)
      : undefined

  const task = registerAsyncAgent({
    agentId,
    description,
    prompt,
    setAppState: rootSetAppState,
    selectedAgent,
    model: lifecycleModel,
    toolUseId: toolUseContext.toolUseId,
    ...(replyTarget !== undefined ? { replyTarget } : {}),
    ...(compactRequested === true ? { compactRequested: true as const } : {}),
  })

  const workerPermissionMode = selectedAgent.permissionMode ?? 'implement'
  let workerTools: ReturnType<typeof resolveWorkerTools>
  try {
    await latchSwarmAgent(
      agentId,
      meta?.name ?? description,
      true,
      undefined,
      task.abortController!.signal,
    )
    const appState = toolUseContext.getAppState()
    const pool = assembleToolPool(
      {
        ...appState.toolPermissionContext,
        mode: workerPermissionMode,
      },
      appState.mcp.tools ?? [],
      agentId,
    )
    workerTools = resolveWorkerTools(selectedAgent, workerPermissionMode, pool)
  } catch (error) {
    failAgentTask(agentId, errorMessage(error), rootSetAppState, task.abortController)
    settleSwarmAgent(agentId)
    throw error
  }

  let saveNote = ''
  try {
    const latestMeta = await readAgentMetadata(typedAgentId)
    const updatedRecord = recordAfterResume(meta, latestMeta, {
      fresh: {
        agentType: selectedAgent.agentType,
        ...(meta?.swarm !== undefined ? { swarm: meta.swarm } : {}),
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(cwdPath !== undefined ? { cwd: cwdPath } : {}),
        description,
        ...(meta?.name !== undefined ? { name: meta.name } : {}),
        ...(meta?.launchedAt !== undefined ? { launchedAt: meta.launchedAt } : {}),
        ...(meta?.swarmBrief !== undefined ? { swarmBrief: meta.swarmBrief } : {}),
        ...(meta?.thinkingConfig !== undefined ? { thinkingConfig: meta.thinkingConfig } : {}),
        ...(structuredOutputSpec !== undefined ? { structuredOutputSpec } : {}),
        ...(meta?.instructionProfile !== undefined ? { instructionProfile: meta.instructionProfile } : {}),
        ...(meta?.instructionDigest !== undefined ? { instructionDigest: meta.instructionDigest } : {}),
      },
      model: restoredModel,
      effortOverride: args.effort ?? meta?.effortOverride,
    })
    await writeAgentMetadata(typedAgentId, updatedRecord)
  } catch (error) {
    saveNote = ` NOTE: the crewmate's record could not be saved (${errorMessage(error)}) — its next resume reads the model, effort and directory recorded before this one.`
  }

  try {
    task.abortController!.signal.throwIfAborted()
    if (isBoardResume && (operatorPauseGate.holds('main') || operatorPauseGate.holds(agentId))) {
      throw new Error('The operator pause is still in force.')
    }
    args.onAdmitted?.()
    swarmResumeAdmitted(agentId)
  } catch (error) {
    failAgentTask(agentId, errorMessage(error), rootSetAppState, task.abortController)
    settleSwarmAgent(agentId)
    throw error
  }

  const effectiveCanUseTool: CanUseToolFn =
    args.canUseTool ??
    (async (_tool, input) => ({ behavior: 'allow', updatedInput: input }))
  startResumedLifecycle({
    agentId,
    typedAgentId,
    prompt,
    description,
    selectedAgent,
    promptMessages,
    toolUseContext,
    rootSetAppState,
    canUseTool: effectiveCanUseTool,
    abortController: task.abortController!,
    workerTools,
    restoredContexts,
    meta,
    restoredModel,
    restoredEffort,
    lifecycleModel,
    structuredOutputSpec,
    contentReplacementState,
    worktreePath,
    cwdPath,
    invokingRequestId: args.invokingRequestId,
    automatic: args.automatic === true,
    replyTarget,
  })

  const note = `${directoryNote}${saveNote}`
  return {
    agentId,
    description,
    outputFile: getTaskOutputPath(agentId),
    ...(directoryFacts.cwdFallback !== undefined ? { cwdFallback: directoryFacts.cwdFallback } : {}),
    ...(directoryFacts.recordedCwd !== undefined ? { recordedCwd: directoryFacts.recordedCwd } : {}),
    ...(note !== '' ? { note } : {}),
  }
}

function startResumedLifecycle(input: {
  agentId: string
  typedAgentId: AgentId
  prompt: string
  description: string
  selectedAgent: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  rootSetAppState: ToolUseContext['setAppState']
  canUseTool: CanUseToolFn
  abortController: AbortController
  workerTools: ReturnType<typeof resolveWorkerTools>
  restoredContexts: ReturnType<typeof recordedRequestContexts>
  meta: Awaited<ReturnType<typeof readAgentMetadata>>
  restoredModel: string | undefined
  restoredEffort: EffortLevel | undefined
  lifecycleModel: string
  structuredOutputSpec: ReturnType<typeof restoreStructuredOutputSpec>
  contentReplacementState: ReturnType<typeof reconstructForSubagentResume>
  worktreePath: string | undefined
  cwdPath: string | undefined
  invokingRequestId: string | undefined
  automatic: boolean
  replyTarget: 'parent' | 'operator' | undefined
}): void {
  const {
    agentId,
    typedAgentId,
    prompt,
    description,
    selectedAgent,
    promptMessages,
    toolUseContext,
    rootSetAppState,
    canUseTool,
    abortController,
    workerTools,
    restoredContexts,
    meta,
    restoredModel,
    restoredEffort,
    lifecycleModel,
    structuredOutputSpec,
    contentReplacementState,
    worktreePath,
    cwdPath,
    invokingRequestId,
    automatic,
    replyTarget,
  } = input
  const querySource = getQuerySourceForAgent(selectedAgent.agentType, isBuiltInAgent(selectedAgent))
  const targetCwd = worktreePath ?? cwdPath ?? getCwdState()
  const agentContext: SubagentContext = {
    agentType: 'subagent',
    agentId: typedAgentId,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invocationKind: 'resume',
    invokingRequestId,
    invocationEmitted: false,
  }
  const enableSummarization = getSdkAgentProgressSummariesEnabled()
  const startTime = Date.now()
  void runWithAgentContext(agentContext, () =>
    runWithCwdOverride(targetCwd, () =>
      runAsyncAgentLifecycle({
        taskId: agentId,
        abortController,
        makeStream: (onCacheSafeParams, onQueryProgress) =>
          runAgent({
            agentDefinition: selectedAgent,
            promptMessages,
            toolUseContext,
            canUseTool,
            isAsync: true,
            resumed: true,
            canShowPermissionPrompts: false,
            querySource,
            availableTools: workerTools,
            override: {
              agentId: typedAgentId,
              abortController,
              ...(restoredContexts?.userContext !== undefined
                ? { userContext: restoredContexts.userContext }
                : {}),
              ...(restoredContexts?.systemContext !== undefined
                ? { systemContext: restoredContexts.systemContext }
                : {}),
              ...(meta?.swarmBrief !== undefined ? { swarmBrief: meta.swarmBrief } : {}),
            },
            ...(restoredModel !== undefined ? { model: restoredModel } : {}),
            ...(restoredEffort !== undefined ? { effortOverride: restoredEffort } : {}),
            ...(meta?.thinkingConfig !== undefined
              ? { thinkingConfigOverride: meta.thinkingConfig }
              : {}),
            ...(meta?.instructionProfile !== undefined
              ? { instructionProfileOverride: meta.instructionProfile }
              : {}),
            ...(structuredOutputSpec !== undefined ? { structuredOutputSpec } : {}),
            ...(contentReplacementState !== undefined ? { contentReplacementState } : {}),
            ...(worktreePath !== undefined ? { worktreePath } : {}),
            ...(cwdPath !== undefined ? { cwd: cwdPath } : {}),
            description,
            ...(meta?.name !== undefined ? { name: meta.name } : {}),
            ...(meta?.launchedAt !== undefined ? { launchedAt: meta.launchedAt } : {}),
            onWait: line => setAgentWaitLine(agentId, line, rootSetAppState),
            onCacheSafeParams,
            ...(onQueryProgress !== undefined ? { onQueryProgress } : {}),
          }),
        metadata: {
          prompt,
          resolvedAgentModel: lifecycleModel,
          isBuiltInAgent: isBuiltInAgent(selectedAgent),
          startTime,
          agentType: selectedAgent.agentType,
          isAsync: true,
          ...(structuredOutputSpec
            ? {
                structuredSpec: {
                  mode: structuredOutputSpec.mode,
                  source: structuredOutputSpec.source,
                },
              }
            : {}),
        },
        description,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization,
        ...(automatic ? { automaticResume: true } : {}),
        ...(replyTarget !== undefined ? { replyTarget } : {}),
        getWorktreeResult: async () => (worktreePath !== undefined ? { worktreePath } : {}),
        canUseTool,
      }),
    ),
  )
}

export function operatorResumeWords(description: string): string {
  return `Crewmate "${description}" resumed from the crew view · it runs on under the same id`
}
