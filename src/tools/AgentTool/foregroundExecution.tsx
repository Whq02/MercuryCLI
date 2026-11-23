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
import { passedOver } from '../../utils/passedOver.js'

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
  const {
    runAgentParams,
    promptMessages,
    prompt,
    description,
    name,
    modelNote,
    metadata,
    startTime,
    syncAgentId,
    syncAgentContext,
    selectedAgent,
    toolUseContext,
    assistantMessage,
    onProgress,
    rootSetAppState,
    backgroundTasksDisabled,
    cleanupWorktreeIfNeeded,
  } = i

  const agentMessages: Message[] = []
  const agentStartTime = startTime
  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools)
  const progressToolUseID = `agent_${assistantMessage.message.id}`

  const initialNormalized = normalizeMessages(promptMessages).find(
    (m): m is NormalizedUserMessage => m.type === 'user',
  )
  if (initialNormalized !== undefined) {
    onProgress?.({
      toolUseID: progressToolUseID,
      data: {
        type: 'agent_progress',
        message: initialNormalized,
        prompt,
        agentId: syncAgentId,
      },
    })
  }

  let foregroundTask: ForegroundTaskHandle | undefined
  let turnAbortedSignal: Promise<typeof TURN_ABORTED> | undefined
  let removeTurnAbortListener: (() => void) | undefined

  if (!backgroundTasksDisabled) {
    foregroundTask = registerAgentForeground({
      agentId: syncAgentId,
      description,
      prompt,
      setAppState: rootSetAppState,
      selectedAgent,
      model: metadata.resolvedAgentModel,
      toolUseId: toolUseContext.toolUseId,
    })
    watchSwarmLaunch(syncAgentId, foregroundTask.abortController.signal)
    if (name !== undefined) {
      registerAgentName(name, syncAgentId, rootSetAppState)
    }
    const parentSignal = toolUseContext.abortController.signal
    turnAbortedSignal = new Promise<typeof TURN_ABORTED>(resolve => {
      if (parentSignal.aborted) {
        resolve(TURN_ABORTED)
        return
      }
      const onAbort = () => resolve(TURN_ABORTED)
      parentSignal.addEventListener('abort', onAbort, { once: true })
      removeTurnAbortListener = () => parentSignal.removeEventListener('abort', onAbort)
    })
  }

  let summarization: { stop(): void } | undefined
  const stopForegroundSummarization = (): void => {
    summarization?.stop()
    summarization = undefined
  }
  const enableSummarization = getSdkAgentProgressSummariesEnabled()

  const agentIterator = runAgent({
    ...runAgentParams,
    override: {
      ...runAgentParams.override,
      agentId: syncAgentId,
      ...(foregroundTask !== undefined ? { abortController: foregroundTask.abortController } : {}),
    },
    ...(foregroundTask !== undefined
      ? {
          onQueryProgress: event =>
            publishAgentWaitFromEvent(foregroundTask.taskId, tracker, event, rootSetAppState),
        }
      : {}),
    ...(foregroundTask !== undefined && enableSummarization
      ? {
          onCacheSafeParams: (cacheSafeParams: CacheSafeParams) => {
            if (summarization === undefined) {
              summarization = startAgentSummarization(
                foregroundTask.taskId,
                syncAgentId,
                cacheSafeParams,
                rootSetAppState,
              )
            }
          },
        }
      : {}),
  })

  let backgrounded = false
  let hintShown = false
  let heldError: unknown
  let seatPause: AgentPauseV1 | null = null
  let worktreeFields: WorktreeFields = {}

  try {
    for (;;) {
      if (
        !hintShown &&
        !backgroundTasksDisabled &&
        toolUseContext.setToolJSX !== undefined &&
        Date.now() - agentStartTime >= BACKGROUND_HINT_DELAY_MS
      ) {
        hintShown = true
        toolUseContext.setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        })
      }

      const nextPromise = agentIterator.next()
      let step: IteratorResult<Message, void>

      if (foregroundTask !== undefined && turnAbortedSignal !== undefined) {
        const winner = await Promise.race([
          nextPromise,
          foregroundTask.backgroundSignal.then(() => BACKGROUNDED),
          turnAbortedSignal,
        ])
        if (winner === TURN_ABORTED || winner === BACKGROUNDED) {
          const handedByTurnAbort = winner === TURN_ABORTED
          if (handedByTurnAbort) {
            backgroundAgentTask(foregroundTask.taskId, toolUseContext.getAppState, rootSetAppState)
          }
          const task = toolUseContext.getAppState().tasks?.[foregroundTask.taskId]
          if (isLocalAgentTask(task) && task.isBackgrounded) {
            backgrounded = true
            const sibling = takeSiblingEnd(foregroundTask.taskId)
            const detached = runWithAgentContext(syncAgentContext, () =>
              runDetachedContinuation(
                {
                  agentMessages,
                  toolUseContext,
                  tracker,
                  resolveActivity,
                  rootSetAppState,
                  description,
                  metadata,
                  agentIterator,
                  backgrounded,
                  foregroundTask,
                  agentStartTime,
                  cleanupWorktreeIfNeeded,
                  stopForegroundSummarization,
                  syncAgentId,
                },
                nextPromise,
              ),
            )
            const canReadOutputFile = toolUseContext.options.tools.some(
              tool =>
                toolMatchesName(tool, FILE_READ_TOOL_NAME) ||
                toolMatchesName(tool, BASH_TOOL_NAME),
            )
            return asyncLaunchedAnswer({
              backgroundedTaskId: foregroundTask.taskId,
              description,
              prompt,
              canReadOutputFile,
              modelNote,
              name,
              handedByTurnAbort,
              sibling,
              task,
              detached,
            })
          }
          step = await nextPromise
        } else {
          step = winner
        }
      } else {
        step = await nextPromise
      }

      if (step.done) break
      const message = step.value
      agentMessages.push(message)
      updateProgressFromMessage(tracker, message, resolveActivity, toolUseContext.options.tools)

      if (foregroundTask !== undefined) {
        if (message.type === 'assistant') {
          publishAgentProgressSoon(foregroundTask.taskId, tracker, rootSetAppState)
        }
        const lastToolName = getLastToolUseName(message)
        if (lastToolName !== undefined) {
          emitTaskProgress(
            tracker,
            foregroundTask.taskId,
            toolUseContext.toolUseId,
            description,
            agentStartTime,
            lastToolName,
          )
        }
      }

      forwardForegroundProgress({
        message,
        toolUseContext,
        onProgress,
        progressToolUseID,
        prompt,
        syncAgentId,
      })
    }
  } catch (error) {
    heldError = error
    if (!backgrounded) {
      await agentIterator.return(undefined).catch(passedOver)
    }
    if (error instanceof AbortError) {
      throw error
    }
    logForDebugging(`runForegroundAgentExecution: ${errorMessage(error)}`)
  } finally {
    toolUseContext.setToolJSX?.(null)
    removeTurnAbortListener?.()
    if (!backgrounded) {
      stopForegroundSummarization()
    }
    if (foregroundTask !== undefined) {
      if (backgrounded) {
        unregisterAgentForeground(foregroundTask.taskId, rootSetAppState)
      } else {
        seatPause = foregroundSeatSettled({
          heldError,
          agentMessages,
          foregroundTask,
          rootSetAppState,
          tracker,
          metadata,
          description,
          toolUseContext,
          agentStartTime,
        })
      }
    }
    if (!backgrounded) {
      clearInvokedSkillsForAgent(syncAgentId)
      worktreeFields = await cleanupWorktreeIfNeeded()
    }
  }

  return settleForegroundResult({
    agentMessages,
    heldError,
    seatPause,
    syncAgentId,
    metadata,
    prompt,
    worktreeFields,
    tracker,
  })
}

function forwardForegroundProgress(args: {
  message: Message
  toolUseContext: ToolUseContext
  onProgress: ForegroundAgentExecutionInput['onProgress']
  progressToolUseID: string
  prompt: string
  syncAgentId: AgentId
}): void {
  const { message, toolUseContext, onProgress, progressToolUseID, prompt, syncAgentId } = args
  if (
    message.type === 'progress' &&
    (message.data.type === 'bash_progress' || message.data.type === 'powershell_progress')
  ) {
    onProgress?.({
      toolUseID: message.parentToolUseID,
      data: message.data,
    })
  } else if (message.type === 'assistant' || message.type === 'user') {
    if (message.type === 'assistant') {
      const length = getAssistantMessageContentLength(message)
      if (length > 0) {
        toolUseContext.setResponseLength(prev => prev + length)
      }
    }
    for (const normalized of normalizeMessages([message])) {
      if (normalized.type === 'assistant' || normalized.type === 'user') {
        onProgress?.({
          toolUseID: progressToolUseID,
          data: {
            type: 'agent_progress',
            message: normalized,
            prompt,
            agentId: syncAgentId,
          },
        })
      }
    }
  }
}

async function settleForegroundResult(args: {
  agentMessages: Message[]
  heldError: unknown
  seatPause: AgentPauseV1 | null
  syncAgentId: AgentId
  metadata: ForegroundAgentMetadata
  prompt: string
  worktreeFields: WorktreeFields
  tracker: ReturnType<typeof createProgressTracker>
}): Promise<ForegroundAgentResult> {
  const {
    agentMessages,
    heldError,
    seatPause,
    syncAgentId,
    metadata,
    prompt,
    worktreeFields,
    tracker,
  } = args
  const lastNonMeta = [...agentMessages]
    .reverse()
    .find(m => m.type !== 'system' && m.type !== 'progress')
  if (lastNonMeta !== undefined && isSyntheticMessage(lastNonMeta)) {
    throw new AbortError()
  }

  const hasAssistant = agentMessages.some(m => m.type === 'assistant')
  if (heldError !== undefined) {
    if (!hasAssistant && seatPause === null) {
      throw heldError
    }
    logForDebugging(
      `runForegroundAgentExecution: recovering partial result after error: ${errorMessage(heldError)}`,
    )
  }

  const terminalFailure =
    heldError !== undefined && seatPause !== null
      ? {
          status: 'failed' as const,
          reason: 'provider-declined' as const,
          error: errorMessage(heldError),
        }
      : undefined

  const finalized = finalizeAgentTool(agentMessages, syncAgentId, metadata, terminalFailure)
  const { failureText, data } = foregroundAnswerOf({
    heldError,
    seatPause,
    finalized,
    prompt,
    agentMessages,
    worktreeFields,
  })
  await attachForegroundEnvelope({
    syncAgentId,
    metadata,
    failureText,
    finalized,
    tracker,
    data,
  })
  return { data }
}

async function runDetachedContinuation(
  needs: DetachedNeeds,
  pending: Promise<IteratorResult<Message, void>>,
): Promise<void> {
  const {
    agentMessages,
    toolUseContext,
    tracker,
    resolveActivity,
    rootSetAppState,
    description,
    metadata,
    agentIterator,
    foregroundTask,
    agentStartTime,
    cleanupWorktreeIfNeeded,
    stopForegroundSummarization,
    syncAgentId,
  } = needs
  const taskId = foregroundTask?.taskId ?? String(syncAgentId)
  const registration = foregroundTask?.abortController

  const consumeMessage = (message: Message): void => {
    agentMessages.push(message)
    emitBackgroundAgentRows(toolUseContext.toolUseId, message)
    updateProgressFromMessage(tracker, message, resolveActivity, toolUseContext.options.tools)
    if (message.type === 'assistant') {
      publishAgentProgressSoon(taskId, tracker, rootSetAppState)
    }
    const lastToolName = getLastToolUseName(message)
    if (lastToolName !== undefined) {
      emitTaskProgress(
        tracker,
        taskId,
        toolUseContext.toolUseId,
        description,
        agentStartTime,
        lastToolName,
      )
    }
  }

  try {
    let next = await pending
    while (!next.done) {
      consumeMessage(next.value)
      next = await agentIterator.next()
    }

    const finalized = finalizeAgentTool(agentMessages, syncAgentId, metadata)
    const declined = finalized.outcome?.status === 'failed' ? finalized.outcome : undefined
    const overload =
      declined !== undefined
        ? overloadPauseOf(agentMessages, metadata.resolvedAgentModel)
        : null
    let notifies = true
    if (overload !== null) {
      const episode = overloadEpisodeOf(taskId)
      noteOverloadDeath(episode)
      notifies = overloadDeathNotifies(episode)
    }
    if (declined !== undefined) {
      failAsyncAgent(taskId, declined.error, rootSetAppState, registration, {
        settleFrame: !notifies,
      })
      if (overload !== null && registration !== undefined) {
        armOverloadProbe({
          taskId,
          description,
          registration,
          toolUseContext,
          rootSetAppState,
          model: metadata.resolvedAgentModel,
          pause: overload.pause,
          afterDeath: true,
        })
      }
    } else {
      closeOverloadEpisode(taskId)
      completeAgentTask(
        { agentId: taskId, ...finalized },
        rootSetAppState,
        registration,
        {
          usage: {
            tokens: getTokenCountFromTracker(tracker),
            toolUses: finalized.totalToolUseCount,
            durationMs: finalized.totalDurationMs,
          },
          settleFrame: false,
        },
      )
    }

    const worktreeResult = await cleanupWorktreeIfNeeded()
    let finalText = extractTextContent(finalized.content, '\n') ?? ''
    if (finalized.outcome?.status === 'completed' && finalized.outcome.promotedNarration) {
      finalText = finalText
        ? `${PROMOTED_NARRATION_NOTE}\n\n${finalText}`
        : PROMOTED_NARRATION_NOTE
    }
    let envelopeBlock: string | undefined
    try {
      const { buildAgentResultEnvelope, formatEnvelopeBlock } = await import(
        '../../services/agentResults/normalize.js'
      )
      envelopeBlock = formatEnvelopeBlock(
        await buildAgentResultEnvelope({
          agentId: String(syncAgentId),
          agentType: metadata.agentType,
          status: declined !== undefined ? 'failed' : 'completed',
          finalText,
          usage: {
            totalTokens: getTokenCountFromTracker(tracker),
            toolUseCount: finalized.totalToolUseCount,
            durationMs: finalized.totalDurationMs,
          },
        }),
      )
    } catch (error) {
      passedOver(error)
    }

    if (notifies) {
      enqueueAgentNotification({
        taskId,
        description,
        status: declined !== undefined ? 'failed' : 'completed',
        ...(declined !== undefined
          ? {
              error: declined.error,
              landedWrites: landedWritesOf(agentMessages),
              lastCalls: lastToolCallsOf(agentMessages),
            }
          : {}),
        ...(overload !== null
          ? {
              statusWord: 'paused',
              summary: overloadNoticeWords(description, overload.who, undefined, overload.status),
            }
          : {}),
        setAppState: rootSetAppState,
        controller: registration,
        finalMessage: finalText,
        ...(finalized.structured !== undefined
          ? { structuredBlock: structuredResultBlock(finalized.structured) }
          : {}),
        usage: {
          totalTokens: getTokenCountFromTracker(tracker),
          toolUses: finalized.totalToolUseCount,
          durationMs: finalized.totalDurationMs,
        },
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
        ...(envelopeBlock !== undefined ? { envelopeBlock } : {}),
      })
    }
  } catch (error) {
    const usage = {
      totalTokens: getTokenCountFromTracker(tracker),
      toolUses: tracker.toolUseCount,
      durationMs: Date.now() - agentStartTime,
    }
    const envelopeUsage = {
      totalTokens: usage.totalTokens,
      toolUseCount: usage.toolUses,
      durationMs: usage.durationMs,
    }
    if (error instanceof AbortError) {
      const stopReason = agentStopReasonOf(registration?.signal.reason)
      killAsyncAgent(taskId, rootSetAppState, stopReason, registration)
      closeOverloadEpisode(taskId)
      const worktreeResult = await cleanupWorktreeIfNeeded()
      await flushSessionStorage().catch(passedOver)
      const partialResult = extractPartialResult(agentMessages)
      const envelopeBlock = await partialResultEnvelopeBlock({
        agentId: String(syncAgentId),
        agentType: metadata.agentType,
        status: 'stopped',
        partialText: partialResult,
        usage: envelopeUsage,
      })
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        controller: registration,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        usage,
        landedWrites: landedWritesOf(agentMessages),
        lastCalls: lastToolCallsOf(agentMessages),
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...worktreeResult,
        ...(envelopeBlock !== undefined ? { envelopeBlock } : {}),
      })
      return
    }

    const errMsg = errorMessage(error)
    const overload = overloadBudgetCutOf(error, metadata.resolvedAgentModel)
    const budgetCut = overload === null ? recoveryBudgetCutOf(error) : null
    let notifies = true
    if (overload !== null) {
      const episode = overloadEpisodeOf(taskId)
      noteOverloadDeath(episode)
      notifies = overloadDeathNotifies(episode)
    }
    failAsyncAgent(taskId, errMsg, rootSetAppState, registration, {
      settleFrame: !notifies,
    })
    const worktreeResult = await cleanupWorktreeIfNeeded()
    await flushSessionStorage().catch(passedOver)
    const partialResult = extractPartialResult(agentMessages)
    const envelopeBlock = await partialResultEnvelopeBlock({
      agentId: String(syncAgentId),
      agentType: metadata.agentType,
      status: 'failed',
      partialText: partialResult,
      usage: envelopeUsage,
    })
    if (notifies) {
      enqueueAgentNotification({
        taskId,
        description,
        status: 'failed',
        error: errMsg,
        ...(overload !== null
          ? {
              statusWord: 'paused',
              summary: overloadNoticeWords(description, overload.who, undefined, overload.status),
            }
          : {}),
        finalMessage: partialResult,
        usage,
        landedWrites: landedWritesOf(agentMessages),
        lastCalls: lastToolCallsOf(agentMessages),
        setAppState: rootSetAppState,
        controller: registration,
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
        ...(envelopeBlock !== undefined ? { envelopeBlock } : {}),
      })
    }
    if (overload !== null && registration !== undefined) {
      armOverloadProbe({
        taskId,
        description,
        registration,
        toolUseContext,
        rootSetAppState,
        model: metadata.resolvedAgentModel,
        pause: overload.pause,
        afterDeath: true,
      })
    } else if (budgetCut !== null && registration !== undefined) {
      const delayMs = budgetCutResumeDelayMs(budgetCut)
      armBudgetCutResume({
        taskId,
        description,
        registration,
        toolUseContext,
        rootSetAppState,
        delayMs,
        pause: {
          why: 'provider busy',
          words: budgetCut.words,
          resumesAtMs: Date.now() + delayMs,
        },
      })
    }
  } finally {
    stopForegroundSummarization()
    clearInvokedSkillsForAgent(syncAgentId)
  }
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
