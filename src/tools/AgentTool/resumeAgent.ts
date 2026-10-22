
import { rebuildSeenLinesFromTranscript } from '../../services/changeTransaction/seenLines.js'
import { processOwnerForLane } from '../../services/run/resolveOwner.js'
import { stat, utimes } from 'node:fs/promises'
import { getEngineModel } from '../../utils/model/model.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { ToolUseContext } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
  setAgentWaitLine,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { recordedDescription } from '../../tasks/LocalAgentTask/launchReceipts.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import {
  workflowOwnedAgentWords,
  workflowOwningAgent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { createUserMessage } from '../../utils/messages.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { restoreBoundPrefixFromMessages } from '../../services/providers/anthropic/boundPrefixRecord.js'
import { pendingToolRosterRestore } from '../../services/providers/toolEconomy.js'
import { getSchemaBoundStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from '../WorkflowTool/structuredOutputTool.js'
import { getCwdState, getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { cancelAutomaticResume, resolveWorkerTools, runAsyncAgentLifecycle } from './agentToolUtils.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { MERCURY_CREW_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'
import { continuationDirectoryNote } from './continuationNote.js'
import { EFFORT_LEVELS, isEffortLevel, resolveStampedEffortTruth, type EffortLevel } from '../../utils/effort.js'
import { matchReachableModelName, modelNameHeadlessRefusal } from '../../utils/model/modelNameRoad.js'
import { MODEL_LOOKUP_LADDER } from '../../utils/model/modelLookup.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from '../../utils/crew/engineDispatch.js'

async function resumedModelOverride(model: string | undefined, parent: string): Promise<string | undefined> {
  if (model === undefined) return undefined
  if (model.trim() === '') throw new Error('Model is empty. Read mercury://models and name a model id.')
  const matched = matchReachableModelName(model, 'pass')
  if (matched !== null && (matched.kind === 'none' || matched.kind === 'ambiguous')) {
    throw new Error(modelNameHeadlessRefusal(matched, 'model') + ' ' + MODEL_LOOKUP_LADDER)
  }
  const word = matched !== null && (matched.kind === 'match' || matched.kind === 'exact') ? matched.id : model
  const resolved = getAgentModel(undefined, parent, word)
  const dispatch = await resolveEngineDispatch(resolved)
  if (dispatch !== null) return dispatch.model
  const refusal = unrecognisedModelWordRefusal(word)
  if (refusal !== null) throw new Error(refusal)
  return resolved
}

type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  cwdFallback?: 'parent-checkout' | 'parent-directory'
  recordedCwd?: string
  note?: string
}

const RESUMED_AGENT_DESCRIPTION = 'Resumed crewmate'

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

export function liveAgentOwner(
  agentId: string,
  tasks: Record<string, unknown> | undefined,
): { kind: 'agent' | 'workflow'; words: string } | null {
  const own = tasks?.[agentId]
  if (isLocalAgentTask(own) && !isMainSessionTask(own) && own.status === 'running') {
    return {
      kind: 'agent',
      words:
        `Crewmate ${agentId} is running in this session — guidance for a running crewmate is queued by SendMessage ` +
        `and delivered at its next tool round; a second run is never started beside it.`,
    }
  }
  const workflow = workflowOwningAgent(tasks, agentId)
  if (workflow !== undefined) return { kind: 'workflow', words: workflowOwnedAgentWords(workflow, agentId) }
  return null
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
}): Promise<ResumeAgentResult> {
  const { agentId, prompt, toolUseContext, canUseTool } = args

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(agentId as AgentId),
    readAgentMetadata(agentId as AgentId),
  ])
  if (!transcript || transcript.messages.length === 0) {
    throw new Error(`No transcript found for crewmate ${agentId}`)
  }
  const definitions = await getAgentDefinitionsWithOverrides(getCwdState())
  const definition: AgentDefinition = definitionForStoredType(meta?.agentType, definitions.activeAgents)
  const restoredModel = (await resumedModelOverride(args.model, toolUseContext.options.engineModel)) ?? meta?.model
  const lifecycleModel = getAgentModel(restoredModel ?? definition.model, getEngineModel())
  const restoredEffort = args.effort ?? meta?.effortOverride ?? meta?.effort
  if (args.effort !== undefined) {
    const selectable = resolveStampedEffortTruth(lifecycleModel, args.effort, { thinkingEnabled: true }).selectable
    if (!isEffortLevel(args.effort) || (args.effort !== 'max' && !selectable.includes(args.effort))) {
      throw new Error(`Effort '${args.effort}' is not served by ${lifecycleModel}; available: ${selectable.length > 0 ? selectable.join(' | ') : 'no effort control'}. The ladder is ${EFFORT_LEVELS.join(' | ')}. Max is admitted; no lower tier was substituted. Read mercury://models for the model's choices.`)
    }
  }
  const restoredKey = restoreBoundPrefixFromMessages(transcript.messages, { rosterOnly: true })
  try {
    const rebuilt = rebuildSeenLinesFromTranscript(processOwnerForLane(agentId), transcript.messages)
    if (rebuilt.files > 0) logForDebugging(`read ledger: crewmate ${agentId} read or wrote ${rebuilt.lines} line(s) of ${rebuilt.files} file(s) before this resume; they still read the same and count as read`)
  } catch (error) {
    logForDebugging(`read ledger: crewmate ${agentId}'s transcript could not be read back for the seen lines (${error instanceof Error ? error.message : String(error)})`)
  }
  const restoredRoster = pendingToolRosterRestore()
  const structuredDefinition = restoredKey !== null && restoredRoster?.key === restoredKey
    ? restoredRoster.marks.find(mark => mark.name === STRUCTURED_OUTPUT_TOOL_NAME)?.definition
    : undefined
  const structuredOutputSpec = meta?.structuredOutputSpec ?? (structuredDefinition === undefined ? undefined : (() => {
    const { input_schema: schema } = JSON.parse(structuredDefinition) as { input_schema: Record<string, unknown> }
    const bound = getSchemaBoundStructuredOutputTool(schema)
    if (bound.error !== undefined) throw new Error(`output_schema is not a valid JSON Schema: ${bound.error}`)
    return { schema, mode: 'permissive' as const, source: 'dispatch' as const }
  })())

  const cleaned = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )

  const contentReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    cleaned,
    transcript.contentReplacements,
  )

  let worktreePath: string | undefined
  if (meta?.worktreePath) {
    try {
      const info = await stat(meta.worktreePath)
      if (info.isDirectory()) {
        worktreePath = meta.worktreePath
        const now = new Date()
        await utimes(meta.worktreePath, now, now).catch(() => {})
      } else {
        logForDebugging(
          `resumeAgent: recorded worktree ${meta.worktreePath} is not a directory — resuming in the parent cwd`,
        )
      }
    } catch {
      logForDebugging(
        `resumeAgent: recorded worktree ${meta.worktreePath} is gone — resuming in the parent cwd`,
      )
    }
  }

  let cwdPath: string | undefined
  if (meta?.cwd) {
    try {
      const info = await stat(meta.cwd)
      if (info.isDirectory()) {
        cwdPath = meta.cwd
      } else {
        logForDebugging(
          `resumeAgent: recorded directory ${meta.cwd} is not a directory — resuming in the parent cwd`,
        )
      }
    } catch {
      logForDebugging(
        `resumeAgent: recorded directory ${meta.cwd} is gone — resuming in the parent cwd`,
      )
    }
  }

  const directoryFacts = meta?.worktreePath && worktreePath === undefined
    ? { cwdFallback: 'parent-checkout' as const }
    : meta?.cwd && cwdPath === undefined
      ? { cwdFallback: 'parent-directory' as const, recordedCwd: meta.cwd }
      : {}
  const note = continuationDirectoryNote(directoryFacts)
  const promptMessages: Message[] = [
    ...cleaned,
    createUserMessage({ content: prompt + note }),
  ]


  const description = recordedDescription(meta?.description) || RESUMED_AGENT_DESCRIPTION

  const instructionProfileOverride = meta?.instructionProfile

  const workerPermissionMode = (definition.permissionMode ?? 'implement') as NonNullable<AgentDefinition['permissionMode']>
  const tools = resolveWorkerTools(
        definition,
        workerPermissionMode,
        assembleToolPool(
          {
            ...toolUseContext.getAppState().toolPermissionContext,
            mode: workerPermissionMode as never,
          },
          toolUseContext.getAppState().mcp?.tools ?? [],
        ),
      )

  const launchName = meta?.name
  const launchedAt = meta?.launchedAt

  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  let tasksNow: Record<string, unknown> | undefined
  rootSetAppState(prev => {
    tasksNow = prev.tasks
    return prev
  })
  const owner = liveAgentOwner(agentId, tasksNow)
  if (owner !== null) throw new Error(owner.words)
  void writeAgentMetadata(agentId as AgentId, {
    agentType: definition.agentType,
    ...(worktreePath ? { worktreePath } : {}),
    ...(cwdPath ? { cwd: cwdPath } : {}),
    description,
    ...(launchName ? { name: launchName } : {}),
    ...(launchedAt !== undefined ? { launchedAt } : {}),
    ...(restoredModel ? { model: restoredModel } : {}),
    ...(restoredEffort ? { effortOverride: restoredEffort } : {}),
    ...(meta?.thinkingConfig ? { thinkingConfig: meta.thinkingConfig } : {}),
    ...(structuredOutputSpec ? { structuredOutputSpec } : {}),
    ...(instructionProfileOverride
      ? { instructionProfile: instructionProfileOverride }
      : {}),
  }).catch(() => {})
  if (args.automatic !== true) {
    cancelAutomaticResume(agentId)
    operatorPauseGate.lift(agentId)
  }
  const previousTask = tasksNow?.[agentId]
  const replyTarget = args.replyTarget ?? (args.automatic === true && isLocalAgentTask(previousTask) ? previousTask.replyTarget : undefined) ?? 'parent'
  const task = registerAsyncAgent({
    agentId,
    description,
    prompt,
    setAppState: rootSetAppState,
    selectedAgent: definition,
    model: lifecycleModel,
    toolUseId: toolUseContext.toolUseId,
    replyTarget,
  })

  const querySource = getQuerySourceForAgent(
    definition.agentType,
    isBuiltInAgent(definition),
  )

  const runLifecycle = () =>
    runAsyncAgentLifecycle({
      taskId: agentId,
      abortController: task.abortController!,
      makeStream: (onCacheSafeParams, onQueryProgress) =>
        runAgent({
          agentDefinition: definition,
          promptMessages,
          ...(onQueryProgress !== undefined ? { onQueryProgress } : {}),
          onWait: line => setAgentWaitLine(agentId, line, rootSetAppState),
          toolUseContext,
          canUseTool: canUseTool ?? ((async () => ({ behavior: 'allow', updatedInput: {} })) as never),
          isAsync: true,
          querySource,
          override: {
            agentId,
            abortController: task.abortController!,
          },
          model: restoredModel,
          availableTools: tools,
          ...(structuredOutputSpec ? { structuredOutputSpec } : {}),
          ...(contentReplacementState ? { contentReplacementState } : {}),
          ...(worktreePath ? { worktreePath } : {}),
          ...(cwdPath ? { cwd: cwdPath } : {}),
          description,
          ...(launchName ? { name: launchName } : {}),
          ...(launchedAt !== undefined ? { launchedAt } : {}),
          effortOverride: restoredEffort,
          thinkingConfigOverride: meta?.thinkingConfig,
          ...(instructionProfileOverride
            ? { instructionProfileOverride }
            : {}),
          onCacheSafeParams: onCacheSafeParams as never,
        }),
      metadata: {
        prompt,
        resolvedAgentModel: lifecycleModel,
        isBuiltInAgent: isBuiltInAgent(definition),
        startTime: Date.now(),
        agentType: definition.agentType,
        isAsync: true,
        ...(structuredOutputSpec ? { structuredSpec: { mode: structuredOutputSpec.mode, source: structuredOutputSpec.source } } : {}),
      },
      description,
      toolUseContext,
      rootSetAppState,
      agentIdForCleanup: agentId,
      automaticResume: args.automatic === true,
      replyTarget,
      enableSummarization: getSdkAgentProgressSummariesEnabled(),
      getWorktreeResult: async () =>
        worktreePath ? { worktreePath } : {},
      canUseTool,
    })

  const resumeContext: SubagentContext = {
    agentType: 'subagent',
    agentId: agentId as AgentId,
    subagentName: definition.agentType,
    isBuiltIn: isBuiltInAgent(definition),
    invokingRequestId: args.invokingRequestId,
    invocationKind: 'resume',
  }
  const directory = worktreePath ?? cwdPath ?? getCwdState()
  void runWithAgentContext(resumeContext, () =>
    directory
      ? runWithCwdOverride(directory, runLifecycle)
      : runLifecycle(),
  )

  return {
    agentId,
    description,
    outputFile: getTaskOutputPath(agentId),
    ...directoryFacts,
    ...(note ? { note } : {}),
  }
}

export function operatorResumeWords(description: string): string {
  return `Crewmate "${description}" resumed from the crew view · it runs on under the same id`
}
