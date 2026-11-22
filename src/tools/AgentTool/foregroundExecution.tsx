import {
  clearInvokedSkillsForAgent,
  getSdkAgentProgressSummariesEnabled,
} from '../../bootstrap/state.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  AGENT_WINDOW_RESUME_NOTE,
  agentStopReasonOf,
  backgroundAgentTask,
  completeAgentTask,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type LocalAgentTaskState,
  overloadPauseOf,
  pauseAgentTask,
  publishAgentProgressSoon,
  publishAgentWaitFromEvent,
  registerAgentForeground,
  registerAgentName,
  settleAgentForeground,
  takeSiblingEnd,
  unregisterAgentForeground,
  updateProgressFromMessage,
  usageWindowPauseOf,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  NormalizedUserMessage,
} from '../../types/message.js'
import type { AgentToolProgress, ShellProgress } from '../../types/tools.js'
import type { SetAppState } from '../../Task.js'
import { runWithAgentContext, type AgentContext } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { mirrorSwarmNotice, watchSwarmLaunch } from '../../services/crewBoard/seam.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import type { CacheSafeParams } from '../../services/agents/forkedAgent.js'
import { pauseLineWords, type AgentPauseV1 } from '../../tasks/LocalAgentTask/agentPause.js'
import {
  extractTextContent,
  isSyntheticMessage,
  normalizeMessages,
} from '../../services/messages.js'
import { emitTaskEnded } from '../../utils/sdkEventQueue.js'
import { emitBackgroundAgentRows } from '../../utils/task/sdkAgentFrames.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getAssistantMessageContentLength } from '../../services/context/tokens.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { BackgroundHint } from '../BashTool/UI.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tools/fileRead.js'
import { noteOverloadDeath, overloadDeathNotifies, overloadNoticeWords } from '../../tasks/LocalAgentTask/agentOverload.js'
import {
  deriveAgentTerminalOutcome,
  emitTaskProgress,
  armBudgetCutResume,
  armOverloadProbe,
  closeOverloadEpisode,
  overloadEpisodeOf,
  extractPartialResult,
  partialResultEnvelopeBlock,
  budgetCutResumeDelayMs,
  recoveryBudgetCutOf,
  overloadBudgetCutOf,
  finalizeAgentTool,
  getLastToolUseName,
  landedWritesOf,
  lastToolCallsOf,
  PROMOTED_NARRATION_NOTE,
  structuredResultBlock,
  type AgentToolResult,
} from './agentToolUtils.js'
import type { BackgroundHandoverReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { AgentDefinition } from '../../types/agent.js'
import { runAgent, type RunAgentParams } from './runAgent.js'
import { passedOver, passedOverAs } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const BACKGROUND_HINT_DELAY_MS = 2_000

const BACKGROUNDED = Symbol('foreground-agent-backgrounded')
const TURN_ABORTED = Symbol('foreground-agent-turn-aborted')

export type ForegroundAgentMetadata = {
  prompt: string
  resolvedAgentModel: string
  isBuiltInAgent: boolean
  startTime: number
  agentType: string
  isAsync: boolean
  structuredSpec?: { mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
}

type WorktreeFields = { worktreePath?: string; worktreeBranch?: string }

type ForegroundAgentResult = {
  data:
    | (AgentToolResult & { status: 'completed'; prompt: string } & WorktreeFields)
    | (AgentToolResult & {
        status: 'failed'
        error: string
        prompt: string
        lastCalls: string[]
      } & WorktreeFields)
    | {
        isAsync: true
        status: 'async_launched'
        agentId: string
        description: string
        prompt: string
        outputFile: string
        canReadOutputFile: boolean
        modelNote?: string
        agentName?: string
        backgroundReason: BackgroundHandoverReason
      }
  detached?: Promise<void>
}

type ForegroundAgentExecutionInput = {
  runAgentParams: RunAgentParams
  promptMessages: Message[]
  prompt: string
  description: string
  name?: string
  modelNote?: string
  metadata: ForegroundAgentMetadata
  startTime: number
  syncAgentId: AgentId
  syncAgentContext: AgentContext
  selectedAgent: AgentDefinition
  toolUseContext: ToolUseContext
  assistantMessage: AssistantMessage
  onProgress?: (progress: {
    toolUseID: string
    data: AgentToolProgress | ShellProgress
  }) => void
  rootSetAppState: SetAppState
  backgroundTasksDisabled: boolean
  cleanupWorktreeIfNeeded: () => Promise<WorktreeFields>
}

export async function runForegroundAgentExecution(
  i: ForegroundAgentExecutionInput,
): Promise<ForegroundAgentResult> {
  return notBuilt('src/tools/AgentTool/foregroundExecution.tsx:151')
}

function asyncLaunchedAnswer(needs: { backgroundedTaskId: string; description: string; prompt: string; canReadOutputFile: boolean; modelNote: string | undefined; name: string | undefined; handedByTurnAbort: boolean; sibling: ReturnType<typeof takeSiblingEnd>; task: LocalAgentTaskState; detached: Promise<void> }): ForegroundAgentResult {
  const { backgroundedTaskId, description, prompt, canReadOutputFile, modelNote, name, handedByTurnAbort, sibling, task, detached } = needs
  return {
    data: {
      isAsync: true,
      status: 'async_launched',
      agentId: backgroundedTaskId,
      description,
      prompt,
      outputFile: getTaskOutputPath(backgroundedTaskId),
      canReadOutputFile,
      ...(modelNote ? { modelNote } : {}),
      ...(name !== undefined ? { agentName: name } : {}),
      backgroundReason: handedByTurnAbort ? 'turn-interrupted' : sibling !== null ? 'sibling-ended' : task.handoverReason ?? 'backgrounded',
      ...(sibling !== null && !handedByTurnAbort ? { siblingEnd: sibling } : {}),
    },
    detached,
  }
}

function foregroundAnswerOf(needs: { heldError: unknown; seatPause: AgentPauseV1 | null; finalized: ReturnType<typeof finalizeAgentTool>; prompt: string; agentMessages: Message[]; worktreeFields: WorktreeFields }) {
  const { heldError, seatPause, finalized, prompt, agentMessages, worktreeFields } = needs
  const failureText =
    heldError !== undefined
      ? seatPause !== null ? `${pauseLineWords(seatPause, Date.now())} — ${errorMessage(heldError)}` : errorMessage(heldError)
      : finalized.outcome?.status === 'failed'
        ?
          seatPause !== null
          ? `${pauseLineWords(seatPause, Date.now())} — ${finalized.outcome.error}`
          : finalized.outcome.error
        : undefined

  const data: ForegroundAgentResult['data'] =
    failureText !== undefined
      ? {
          status: 'failed' as const,
          error: failureText,
          prompt,
          lastCalls: lastToolCallsOf(agentMessages),
          ...finalized,
          ...worktreeFields,
        }
      : { status: 'completed', prompt, ...finalized, ...worktreeFields }
  return { failureText, data }
}

async function attachForegroundEnvelope(needs: { syncAgentId: AgentId; metadata: ForegroundAgentMetadata; failureText: string | undefined; finalized: ReturnType<typeof finalizeAgentTool>; tracker: ReturnType<typeof createProgressTracker>; data: ForegroundAgentResult['data'] }): Promise<void> {
  const { syncAgentId, metadata, failureText, finalized, tracker, data } = needs
  try {
    const [{ buildAgentResultEnvelope }, { attachAgentEnvelope }] =
      await Promise.all([
        import('../../services/agentResults/normalize.js'),
        import('../../services/agentResults/ingest.js'),
      ])
    const envelope = await buildAgentResultEnvelope({
      agentId: String(syncAgentId),
      agentType: metadata.agentType,
      status: failureText !== undefined ? 'failed' : 'completed',
      finalText: extractTextContent(finalized.content, '\n') ?? '',
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUseCount: finalized.totalToolUseCount,
        durationMs: finalized.totalDurationMs,
      },
    })
    attachAgentEnvelope(data, envelope)
  } catch (error) {
    passedOver(error)
  }
}

type ForegroundTaskHandle = { taskId: string; abortController: AbortController; backgroundSignal: Promise<void> }

type DetachedNeeds = {
  agentMessages: Message[]; toolUseContext: ToolUseContext; tracker: ReturnType<typeof createProgressTracker>; resolveActivity: ReturnType<typeof createActivityDescriptionResolver>
  rootSetAppState: SetAppState; description: string; metadata: ForegroundAgentMetadata; agentIterator: ReturnType<typeof runAgent>; backgrounded: boolean
  foregroundTask: ForegroundTaskHandle | undefined; agentStartTime: number; cleanupWorktreeIfNeeded: () => Promise<WorktreeFields>; stopForegroundSummarization: () => void; syncAgentId: AgentId
}

type SeatSettledNeeds = {
  heldError: unknown; agentMessages: Message[]; foregroundTask: ForegroundTaskHandle; rootSetAppState: SetAppState; tracker: ReturnType<typeof createProgressTracker>
  metadata: ForegroundAgentMetadata; description: string; toolUseContext: ToolUseContext; agentStartTime: number
}

function foregroundSeatSettled(needs: SeatSettledNeeds): AgentPauseV1 | null {
  const { heldError, agentMessages, foregroundTask, rootSetAppState, tracker, metadata, description, toolUseContext, agentStartTime } = needs
  let seatPause: AgentPauseV1 | null = null
  const outcome = heldError === undefined ? deriveAgentTerminalOutcome(agentMessages) : null
  const status: 'completed' | 'failed' | 'stopped' =
    heldError instanceof AbortError
      ? 'stopped'
      : heldError !== undefined
        ? 'failed'
        : outcome!.status
  const why =
    outcome !== null && outcome.status === 'failed'
      ? { error: outcome.error }
      : status === 'failed' && heldError !== undefined
        ? { error: errorMessage(heldError) }
        : undefined
  settleAgentForeground(foregroundTask.taskId, status, rootSetAppState, getProgressUpdate(tracker), why)
  const windowPause = outcome !== null && outcome.status === 'failed' ? usageWindowPauseOf(agentMessages, metadata.resolvedAgentModel) : null
  const overload = heldError !== undefined
    ? overloadBudgetCutOf(heldError, metadata.resolvedAgentModel)
    : outcome !== null && outcome.status === 'failed' && windowPause === null ? overloadPauseOf(agentMessages, metadata.resolvedAgentModel) : null
  seatPause = windowPause ?? overload?.pause ?? null
  if (overload !== null) {
    noteOverloadDeath(overloadEpisodeOf(foregroundTask.taskId))
    armOverloadProbe({
      taskId: foregroundTask.taskId,
      description,
      registration: foregroundTask.abortController,
      toolUseContext,
      rootSetAppState,
      model: metadata.resolvedAgentModel,
      pause: overload.pause,
      afterDeath: true,
    })
  } else if (windowPause !== null) {
    if (windowPause.resumesAtMs !== undefined) {
      armBudgetCutResume({
        taskId: foregroundTask.taskId,
        description,
        registration: foregroundTask.abortController,
        toolUseContext,
        rootSetAppState,
        delayMs: Math.max(1_000, windowPause.resumesAtMs - Date.now() + 1_000),
        pause: windowPause,
        prompt: AGENT_WINDOW_RESUME_NOTE,
        summary: `Agent "${description}" resumed by itself — the usage window reset; its partial work carried forward`,
      })
    } else {
      pauseAgentTask(foregroundTask.taskId, windowPause, rootSetAppState, foregroundTask.abortController)
    }
  }
  const mirrored = mirrorSwarmNotice(foregroundTask.taskId, `settled:${foregroundTask.taskId}:${agentStartTime}`, description, seatPause ? 'paused' : status)
  if (mirrored && !mirrored.ok) logForDebugging(`crew board: ${mirrored.reason}`)
  emitTaskEnded(foregroundTask.taskId, status, {
    ...(toolUseContext.toolUseId !== undefined ? { toolUseId: toolUseContext.toolUseId } : {}),
    summary: description,
    usage: { tokens: getTokenCountFromTracker(tracker), toolUses: tracker.toolUseCount, durationMs: Date.now() - agentStartTime },
  })
  return seatPause
}
