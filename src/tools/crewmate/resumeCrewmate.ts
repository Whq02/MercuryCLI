import { rebuildSeenLinesFromTranscript } from '../engines/change-transaction/seenLines.js'
import { processOwnerForLane } from '../../engine/run-owner/resolveOwner.js'
import { stat, utimes } from 'node:fs/promises'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { getAgentModel } from '../../models/catalogue/agentModel.js'
import { crewmateModelOverride } from '../../crew/crewmates/crewmateModelWord.js'
import { recordAfterResume } from '../../crew/crewmates/crewmateRecord.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { AgentId } from '../../sessions/transcripts/ids.js'
import { asAgentId } from '../../sessions/transcripts/ids.js'
import type { CanUseToolFn, ToolUseContext } from '../kit/tool.js'
import { assembleToolPool } from '../kit/toolList.js'
import { latchSwarmAgent, settleSwarmAgent, swarmResumeAdmitted } from '../../crew/board/seam.js'
import {
  failAgentTask,
  isLocalAgentTask,
  registerAsyncAgent,
  setAgentWaitLine,
} from '../../engine/tasks/local-agent/crewmateTask.js'
import { recordedDescription } from '../../engine/tasks/local-agent/launchReceipts.js'
import { getTaskOutputPath } from '../../engine/task-framework/diskOutput.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../../crew/agents/agentContext.js'
import { runWithCwdOverride } from '../../platform/files/cwd.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
} from '../../engine/messages/messages.js'
import { settleToolUsesOfEndedRun } from '../../engine/messages/apiFilters.js'
import { createUserMessage } from '../../engine/messages/messages.js'
import { createAttachmentMessage } from '../../engine/attachments/turnAttachments.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { getQuerySourceForAgent } from './promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
  writeAgentMetadata,
} from '../../sessions/transcripts/sessionStorage.js'
import { reconstructForSubagentResume } from '../../engine/tool-dispatch/toolResultStorage.js'
import { recordedRequestContexts, restoreBoundPrefixFromMessages } from '../../models/roads/anthropic/boundPrefixRecord.js'
import { pendingToolRosterRestore } from '../../models/roads/toolEconomy.js'
import { createSyntheticOutputTool } from '../structured-output/SyntheticOutputTool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../kit/names/syntheticOutput.js'
import { getCwdState, getSdkAgentProgressSummariesEnabled } from '../../boot/process-state/processState.js'
import { automaticResumePending, cancelAutomaticResume, resolveWorkerTools, runAsyncAgentLifecycle } from './crewmateLifecycle.js'
import { operatorPauseGate } from '../../engine/loop/pauseGate.js'
import { MERCURY_CREW_AGENT_TYPE } from '../kit/names/agent.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from '../../crew/agents/agentDefinition.js'
import { runAgent } from './runCrewmate.js'
import { continuationDirectoryNote } from './continuationNote.js'
import { EFFORT_LEVELS, isEffortLevel, resolveStampedEffortTruth, type EffortLevel } from '../../models/effort/effort.js'
import { liveAgentOwner } from './liveAgentOwner.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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

async function existingDirectory(
  path: string | undefined,
  kind: 'worktree' | 'directory',
  silent: boolean,
): Promise<string | undefined> {
  if (!path) return undefined
  const prefix =
    kind === 'worktree'
      ? 'resumeAgent: recorded worktree'
      : 'resumeAgent: recorded directory'
  try {
    if ((await stat(path)).isDirectory()) return path
    if (!silent) {
      logForDebugging(`${prefix} ${path} is not a directory — resuming in the parent cwd`)
    }
    return undefined
  } catch (error) {
    passedOver(error)
    if (!silent) {
      logForDebugging(`${prefix} ${path} is gone — resuming in the parent cwd`)
    }
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    const mark = restore?.marks.find(entry => entry.name === SYNTHETIC_OUTPUT_TOOL_NAME)
    if (mark?.definition !== undefined) {
      try {
        const parsed: unknown = JSON.parse(mark.definition)
        if (isRecord(parsed) && isRecord(parsed.input_schema)) {
          spec = {
            schema: parsed.input_schema,
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
    const bound = createSyntheticOutputTool(spec.schema)
    if (!bound.ok) {
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
  const typedAgentId = asAgentId(agentId)
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
  if (restoredContexts !== null) {
    logForDebugging(
      `resumeAgent: crewmate ${agentId} resumes with the contexts its first exchange recorded (${Object.keys(restoredContexts).join(', ')}), so its signed prefix holds`,
    )
  }
  try {
    const rebuilt = rebuildSeenLinesFromTranscript(processOwnerForLane(agentId), transcript.messages)
    if (rebuilt.files > 0) {
      logForDebugging(
        `read ledger: crewmate ${agentId} read or wrote ${rebuilt.lines} line(s) of ${rebuilt.files} file(s) before this resume; they still read the same and count as read`,
      )
    }
  } catch (error) {
    logForDebugging(
      `read ledger: crewmate ${agentId}'s transcript could not be read back for the seen lines (${errorMessage(error)})`,
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

  const isBoardResume = args.boardEventIds !== undefined
  const worktreePath = await existingDirectory(meta?.worktreePath, 'worktree', isBoardResume)
  if (worktreePath !== undefined) {
    const now = new Date()
    await utimes(worktreePath, now, now).catch(passedOver)
  }
  const cwdPath = await existingDirectory(meta?.cwd, 'directory', isBoardResume)
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
      throw new Error('A board resume needs the lead’s guarded resume context.')
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
  const replyTarget =
    args.replyTarget ?? (args.automatic === true ? previousTask?.replyTarget : undefined) ?? 'parent'
  const compactRequested: true | undefined =
    meta?.compactOnResume === true || previousTask?.compactRequested === true
      ? true
      : undefined
  if (compactRequested === true) {
    logForDebugging(
      `resumeAgent: crewmate ${agentId} compacts first — the operator asked for it from the crew view`,
    )
  }

  const task = registerAsyncAgent({
    agentId,
    description,
    prompt,
    setAppState: rootSetAppState,
    selectedAgent,
    model: lifecycleModel,
    toolUseId: toolUseContext.toolUseId,
    replyTarget,
    ...(compactRequested === true ? { compactRequested } : {}),
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

  startResumedLifecycle({
    agentId,
    typedAgentId,
    prompt,
    description,
    selectedAgent,
    promptMessages,
    toolUseContext,
    rootSetAppState,
    canUseTool: args.canUseTool,
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
  canUseTool: CanUseToolFn | undefined
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
  replyTarget: 'parent' | 'operator'
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
            canUseTool: canUseTool ?? (async () => ({ behavior: 'allow', updatedInput: {} })),
            isAsync: true,
            resumed: true,
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
            model: restoredModel,
            effortOverride: restoredEffort,
            thinkingConfigOverride: meta?.thinkingConfig,
            ...(meta?.instructionProfile !== undefined
              ? { instructionProfileOverride: meta.instructionProfile }
              : {}),
            structuredOutputSpec,
            contentReplacementState,
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
        replyTarget,
        getWorktreeResult: async () => (worktreePath !== undefined ? { worktreePath } : {}),
        canUseTool,
      }),
    ),
  )
}

export function operatorResumeWords(description: string): string {
  return `Crewmate "${description}" resumed from the crew view · it runs on under the same id`
}
