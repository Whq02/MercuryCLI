// Resume a previously-run agent as a background task from its persisted
// transcript + metadata. Mercury layer: launch-parity restore —
// the persisted model rides back through the one model-resolution
// chokepoint, the persisted effort override is restored as-is, and the
// persisted instruction profile is restored only when it still validates.

import { stat, utimes } from 'node:fs/promises'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { ToolUseContext } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import {
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
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
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { FORK_AGENT, FORK_SUBAGENT_TYPE, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  /** Set when the recorded worktree no longer exists: the agent now runs
   *  in the PARENT checkout — the sender must know the ground shifted
   *  (spec 03-C2: a folded worktree changes what a revival can touch). */
  cwdFallback?: 'parent-checkout'
}

/** Generic description when the original spawn recorded none. */
const RESUMED_AGENT_DESCRIPTION = 'Resumed agent'

/**
 * Resume an agent in the background from its persisted transcript and
 * metadata. Throws when no transcript exists, and when a fork's parent
 * system prompt cannot be reconstructed.
 */
export async function resumeAgentBackground(args: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool?: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const { agentId, prompt, toolUseContext, canUseTool } = args

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(agentId as AgentId),
    readAgentMetadata(agentId as AgentId),
  ])
  if (!transcript || transcript.messages.length === 0) {
    throw new Error(`No transcript found for agent ${agentId}`)
  }

  // Clean the resumed messages: unresolved tool uses, then orphaned
  // thinking-only messages, then whitespace-only assistant messages.
  const cleaned = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )

  // The cleaned transcript IS the conversation: history replayed as prompt
  // messages with the resume prompt appended — never as fork context
  // (re-supplying the fork slice would duplicate tool-use identifiers).
  const promptMessages: Message[] = [
    ...cleaned,
    createUserMessage({ content: prompt }),
  ]

  // Reconstruct tool-result replacement state so the same results are
  // re-replaced and the prompt cache stays stable.
  const contentReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    cleaned,
    transcript.contentReplacements,
  )

  // Worktree: stat it; gone or not a directory ⇒ log and fall back to the
  // parent cwd. Alive ⇒ bump mtime so stale-worktree cleanup skips it.
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

  // Definition selection (permission re-gating deliberately skipped — the
  // original spawn already passed it).
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

  // Fork resume reconstructs the parent system prompt exactly as the fork
  // spawn would: the context's frozen rendered prompt when present, else a
  // rebuild; failure to reconstruct is a hard error.
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

  // Launch parity: the persisted model rides back through the same
  // chokepoint (exact ids keep their transport, the never-lightweight
  // floor still fires on a restored lightweight id). Absent ⇒ re-resolve.
  const restoredModel = meta?.model
  const lifecycleModel = getAgentModel(
    restoredModel ?? definition.model,
    getMainLoopModel(),
    undefined,
    definition.permissionMode as never,
  )
  const restoredEffort = meta?.effortOverride
  const instructionProfileOverride = meta?.instructionProfile

  // Tool pool: a resumed fork uses the parent's exact tools; otherwise
  // assemble under the definition's permission mode (default implement).
  const tools = isForkResume
    ? toolUseContext.options.tools
    : assembleToolPool(
        {
          ...toolUseContext.getAppState().toolPermissionContext,
          mode: (definition.permissionMode ?? 'implement') as never,
        },
        [],
      )

  // Re-persist worktree path + description so they survive the run loop's
  // metadata write.
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

  // Register the background task under the SAME agent id; the original
  // name-registry entry stands (no write here).
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
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
      makeStream: onCacheSafeParams =>
        runAgent({
          agentDefinition: definition,
          promptMessages,
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
      // Spawn-path summarization adds a coordinator term; resume enables on
      // the stamp gate or the SDK flag only.
      enableSummarization:
        isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
      // A resumed agent NEVER settles or removes a worktree — report the
      // surviving path and nothing else.
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
    // The recorded worktree existed but is gone ⇒ the revival runs in the
    // parent checkout; the caller surfaces this, never a silent shift.
    ...(meta?.worktreePath && worktreePath === undefined
      ? { cwdFallback: 'parent-checkout' as const }
      : {}),
  }
}
