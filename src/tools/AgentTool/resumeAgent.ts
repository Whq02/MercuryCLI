
import { stat, utimes } from 'node:fs/promises'
import { getMainLoopModel } from '../../utils/model/model.js'
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
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
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
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { cancelAutomaticResume, resolveWorkerTools, runAsyncAgentLifecycle } from './agentToolUtils.js'
import { FORK_AGENT, FORK_SUBAGENT_TYPE, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  cwdFallback?: 'parent-checkout'
}

const RESUMED_AGENT_DESCRIPTION = 'Resumed agent'

export function liveAgentOwner(
  agentId: string,
  tasks: Record<string, unknown> | undefined,
): { kind: 'agent' | 'workflow'; words: string } | null {
  const own = tasks?.[agentId]
  if (isLocalAgentTask(own) && !isMainSessionTask(own) && own.status === 'running') {
    return {
      kind: 'agent',
      words:
        `Agent ${agentId} is running in this session — guidance for a running agent is queued by SendMessage ` +
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
  automatic?: boolean
}): Promise<ResumeAgentResult> {
  const { agentId, prompt, toolUseContext, canUseTool } = args

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(agentId as AgentId),
    readAgentMetadata(agentId as AgentId),
  ])
  if (!transcript || transcript.messages.length === 0) {
    throw new Error(`No transcript found for agent ${agentId}`)
  }

  const cleaned = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )

  const promptMessages: Message[] = [
    ...cleaned,
    createUserMessage({ content: prompt }),
  ]

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

  const isForkResume = meta?.agentType === FORK_SUBAGENT_TYPE
  let definition: AgentDefinition
  if (isForkResume) {
    definition = FORK_AGENT
  } else {
    const definitions = await getAgentDefinitionsWithOverrides(getCwd())
    definition =
      definitions.activeAgents.find(
        agent => agent.agentType === meta?.agentType,
      ) ??
      definitions.activeAgents.find(
        agent => agent.agentType === 'general-purpose',
      ) ??
      definitions.activeAgents[0]!
  }

  const description = meta?.description ?? RESUMED_AGENT_DESCRIPTION

  let systemPromptOverride: string[] | undefined
  if (isForkResume) {
    const rendered = toolUseContext.renderedSystemPrompt
    if (rendered && rendered.length > 0) {
      systemPromptOverride = [...rendered]
    } else {
      try {
        systemPromptOverride = await getSystemPrompt(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          Array.from(
            toolUseContext
              .getAppState()
              .toolPermissionContext.additionalWorkingDirectories.keys(),
          ),
          toolUseContext.options.mcpClients,
        )
      } catch (error) {
        throw new Error(
          `Cannot resume a fork agent: the parent system prompt could not be reconstructed (${errorMessage(error)})`,
        )
      }
      if (!systemPromptOverride || systemPromptOverride.length === 0) {
        throw new Error(
          'Cannot resume a fork agent: the parent system prompt could not be reconstructed',
        )
      }
    }
  }

  const restoredModel = meta?.model
  const lifecycleModel = getAgentModel(
    restoredModel ?? definition.model,
    getMainLoopModel(),
    undefined,
    definition.permissionMode as never,
  )
  const restoredEffort = meta?.effortOverride
  const instructionProfileOverride = meta?.instructionProfile

  const workerPermissionMode = (definition.permissionMode ?? 'implement') as NonNullable<AgentDefinition['permissionMode']>
  const tools = isForkResume
    ? toolUseContext.options.tools
    : resolveWorkerTools(
        definition,
        workerPermissionMode,
        assembleToolPool(
          {
            ...toolUseContext.getAppState().toolPermissionContext,
            mode: workerPermissionMode as never,
          },
          toolUseContext.getAppState().mcp?.tools ?? [],
        ),
        true,
      )

  void writeAgentMetadata(agentId as AgentId, {
    agentType: definition.agentType,
    ...(worktreePath ? { worktreePath } : {}),
    description,
    ...(restoredModel ? { model: restoredModel } : {}),
    ...(restoredEffort ? { effortOverride: restoredEffort } : {}),
    ...(instructionProfileOverride
      ? { instructionProfile: instructionProfileOverride }
      : {}),
  }).catch(() => {})

  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  let tasksNow: Record<string, unknown> | undefined
  rootSetAppState(prev => {
    tasksNow = prev.tasks
    return prev
  })
  const owner = liveAgentOwner(agentId, tasksNow)
  if (owner !== null) throw new Error(owner.words)
  if (args.automatic !== true) cancelAutomaticResume(agentId)
  const task = registerAsyncAgent({
    agentId,
    description,
    prompt,
    setAppState: rootSetAppState,
    selectedAgent: definition,
    model: lifecycleModel,
    toolUseId: toolUseContext.toolUseId,
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
            ...(systemPromptOverride
              ? { systemPrompt: systemPromptOverride }
              : {}),
          },
          model: restoredModel,
          availableTools: tools,
          ...(contentReplacementState ? { contentReplacementState } : {}),
          ...(isForkResume ? { useExactTools: true } : {}),
          ...(worktreePath ? { worktreePath } : {}),
          description,
          effortOverride: meta?.effortOverride,
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
      },
      description,
      toolUseContext,
      rootSetAppState,
      agentIdForCleanup: agentId,
      automaticResume: args.automatic === true,
      enableSummarization:
        isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
      getWorktreeResult: async () =>
        worktreePath ? { worktreePath } : {},
      canUseTool,
    })

  const resumeContext: SubagentContext = {
    agentType: 'subagent',
    agentId: agentId as AgentId,
    parentSessionId: undefined,
    subagentName: definition.agentType,
    isBuiltIn: isBuiltInAgent(definition),
    invokingRequestId: args.invokingRequestId,
    invocationKind: 'resume',
  }
  void runWithAgentContext(resumeContext, () =>
    worktreePath
      ? runWithCwdOverride(worktreePath, runLifecycle)
      : runLifecycle(),
  )

  return {
    agentId,
    description,
    outputFile: getTaskOutputPath(agentId),
    ...(meta?.worktreePath && worktreePath === undefined
      ? { cwdFallback: 'parent-checkout' as const }
      : {}),
  }
}
