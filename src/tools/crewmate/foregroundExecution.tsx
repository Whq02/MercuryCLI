import { clearInvokedSkillsForAgent } from '../../boot/process-state/processState.js'
import {
  CREWMATE_WINDOW_RESUME_NOTE,
  crewmateStopReasonOf,
  backgroundCrewmateTask,
  completeCrewmateTask,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueCrewmateNotification,
  failCrewmateTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isCrewmateTask,
  killAsyncCrewmate,
  type CrewmateTaskState,
  overloadPauseOf,
  pauseCrewmateTask,
  publishCrewmateProgressSoon,
  publishCrewmateWaitFromEvent,
  registerCrewmateForeground,
  registerCrewmateName,
  settleCrewmateForeground,
  takeSiblingEnd,
  unregisterCrewmateForeground,
  updateProgressFromMessage,
  usageWindowPauseOf,
} from '../../engine/tasks/local-agent/crewmateTask.js'
import { toolMatchesName, type ToolUseContext } from '../kit/tool.js'
import type { AgentId } from '../../sessions/transcripts/ids.js'
import type {
  AssistantMessage,
  Message,
  NormalizedUserMessage,
} from '../../engine/message-shapes/message.js'
import type { CrewmateToolProgress, ShellProgress } from '../kit/toolProgress.js'
import type { SetAppState } from '../../engine/tasks/taskBase.js'
import { runWithCrewmateContext, type AgentContext } from '../../crew/agents/crewmateContext.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { mirrorSwarmNotice, watchSwarmLaunch } from '../../crew/board/seam.js'
import { AbortError, errorMessage } from '../../platform/errors/errors.js'
import { flushSessionStorage } from '../../sessions/transcripts/sessionStorage.js'
import { pauseLineWords, type CrewmatePauseV1 } from '../../engine/tasks/local-agent/crewmatePause.js'
import {
  extractTextContent,
  isSyntheticMessage,
  normalizeMessages,
} from '../../engine/messages/messages.js'
import { emitTaskEnded } from '../../daemon/runner/sdkEventQueue.js'
import { emitBackgroundCrewmateRows } from '../../engine/task-framework/sdkCrewmateFrames.js'
import { getTaskOutputPath } from '../../engine/task-framework/diskOutput.js'
import { getAssistantMessageContentLength } from '../../engine/context-window/contextTokenCount.js'
import { BASH_TOOL_NAME } from '../kit/names/bash.js'
import { BackgroundHint } from '../shell/rows.js'
import { READ_TOOL_NAME } from '../kit/names/read.js'
import { noteOverloadDeath, overloadDeathNotifies, overloadNoticeWords } from '../../engine/tasks/local-agent/crewmateOverload.js'
import {
  deriveCrewmateTerminalOutcome,
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
  finalizeCrewmateTool,
  getLastToolUseName,
  landedWritesOf,
  lastToolCallsOf,
  PROMOTED_NARRATION_NOTE,
  structuredResultBlock,
  type CrewmateToolResult,
} from './crewmateLifecycle.js'
import type { BackgroundHandoverReason } from '../../engine/tasks/local-agent/launchReceipts.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { runCrewmate, type RunCrewmateParams } from './runCrewmate.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const BACKGROUND_HINT_DELAY_MS = 2_000

const BACKGROUNDED = Symbol('foreground-agent-backgrounded')
const TURN_ABORTED = Symbol('foreground-agent-turn-aborted')

export type ForegroundCrewmateMetadata = {
  prompt: string
  resolvedAgentModel: string
  isBuiltInAgent: boolean
  startTime: number
  agentType: string
  isAsync: boolean
  structuredSpec?: { mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
}

type WorktreeFields = { worktreePath?: string; worktreeBranch?: string }

type ForegroundCrewmateResult = {
  data:
    | (CrewmateToolResult & { status: 'completed'; prompt: string } & WorktreeFields)
    | (CrewmateToolResult & {
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

type ForegroundCrewmateExecutionInput = {
  runAgentParams: RunCrewmateParams
  promptMessages: Message[]
  prompt: string
  description: string
  name?: string
  modelNote?: string
  metadata: ForegroundCrewmateMetadata
  startTime: number
  syncAgentId: AgentId
  syncAgentContext: AgentContext
  selectedAgent: AgentDefinition
  toolUseContext: ToolUseContext
  assistantMessage: AssistantMessage
  onProgress?: (progress: {
    toolUseID: string
    data: CrewmateToolProgress | ShellProgress
  }) => void
  rootSetAppState: SetAppState
  backgroundTasksDisabled: boolean
  cleanupWorktreeIfNeeded: () => Promise<WorktreeFields>
}

export async function runForegroundCrewmateExecution(
  i: ForegroundCrewmateExecutionInput,
): Promise<ForegroundCrewmateResult> {
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
  let backgroundedSignal: Promise<typeof BACKGROUNDED> | undefined
  let turnAbortedSignal: Promise<typeof TURN_ABORTED> | undefined
  let removeTurnAbortListener: (() => void) | undefined

  if (!backgroundTasksDisabled) {
    foregroundTask = registerCrewmateForeground({
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
      registerCrewmateName(name, syncAgentId, rootSetAppState)
    }
    backgroundedSignal = foregroundTask.backgroundSignal.then(
      (): typeof BACKGROUNDED => BACKGROUNDED,
    )
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

  const agentIterator = runCrewmate({
    ...runAgentParams,
    override: {
      ...runAgentParams.override,
      agentId: syncAgentId,
      ...(foregroundTask !== undefined ? { abortController: foregroundTask.abortController } : {}),
    },
    ...(foregroundTask !== undefined
      ? {
          onTurnProgress: event =>
            publishCrewmateWaitFromEvent(foregroundTask.taskId, tracker, event, rootSetAppState),
        }
      : {}),
  })

  let backgrounded = false
  let hintShown = false
  let heldError: unknown
  let seatPause: CrewmatePauseV1 | null = null
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
          shouldHideComposer: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        })
      }

      const nextPromise = agentIterator.next()
      let step: IteratorResult<Message, void>

      if (
        foregroundTask !== undefined &&
        (backgroundedSignal !== undefined || turnAbortedSignal !== undefined)
      ) {
        const racers: Promise<
          IteratorResult<Message, void> | typeof BACKGROUNDED | typeof TURN_ABORTED
        >[] = [nextPromise]
        if (backgroundedSignal !== undefined) racers.push(backgroundedSignal)
        if (turnAbortedSignal !== undefined) racers.push(turnAbortedSignal)
        const winner = await Promise.race(racers)
        if (winner === TURN_ABORTED || winner === BACKGROUNDED) {
          const handedByTurnAbort = winner === TURN_ABORTED
          if (handedByTurnAbort) {
            backgroundCrewmateTask(foregroundTask.taskId, toolUseContext.getAppState, rootSetAppState)
          }
          const task = toolUseContext.getAppState().tasks?.[foregroundTask.taskId]
          if (isCrewmateTask(task) && task.isBackgrounded) {
            backgrounded = true
            const sibling = takeSiblingEnd(foregroundTask.taskId)
            const detached = runWithCrewmateContext(syncAgentContext, () =>
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
                  syncAgentId,
                },
                nextPromise,
              ),
            )
            const canReadOutputFile = toolUseContext.options.tools.some(
              tool =>
                toolMatchesName(tool, READ_TOOL_NAME) ||
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
          if (handedByTurnAbort) {
            turnAbortedSignal = undefined
          } else {
            backgroundedSignal = undefined
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
          publishCrewmateProgressSoon(foregroundTask.taskId, tracker, rootSetAppState)
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
    logForDebugging(`Sync agent error: ${errorMessage(error)}`)
  } finally {
    toolUseContext.setToolJSX?.(null)
    removeTurnAbortListener?.()
    if (foregroundTask !== undefined) {
      if (backgrounded) {
        unregisterCrewmateForeground(foregroundTask.taskId, rootSetAppState)
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
  onProgress: ForegroundCrewmateExecutionInput['onProgress']
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
  seatPause: CrewmatePauseV1 | null
  syncAgentId: AgentId
  metadata: ForegroundCrewmateMetadata
  prompt: string
  worktreeFields: WorktreeFields
  tracker: ReturnType<typeof createProgressTracker>
}): Promise<ForegroundCrewmateResult> {
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
      `Sync agent recovered with partial output: ${errorMessage(heldError)}`,
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

  const finalized = finalizeCrewmateTool(agentMessages, syncAgentId, metadata, terminalFailure)
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
    syncAgentId,
  } = needs
  const taskId = foregroundTask?.taskId ?? String(syncAgentId)
  const registration = foregroundTask?.abortController

  const consumeMessage = (message: Message): void => {
    agentMessages.push(message)
    emitBackgroundCrewmateRows(toolUseContext.toolUseId, message)
    updateProgressFromMessage(tracker, message, resolveActivity, toolUseContext.options.tools)
    if (message.type === 'assistant') {
      publishCrewmateProgressSoon(taskId, tracker, rootSetAppState)
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

    const finalized = finalizeCrewmateTool(agentMessages, syncAgentId, metadata)
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
      completeCrewmateTask(
        { ...finalized, agentId: taskId },
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
      const { buildCrewmateResultEnvelope, formatEnvelopeBlock } = await import(
        '../../crew/agent-results/normalize.js'
      )
      envelopeBlock = formatEnvelopeBlock(
        await buildCrewmateResultEnvelope({
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
      enqueueCrewmateNotification({
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
      const stopReason = crewmateStopReasonOf(registration?.signal.reason)
      killAsyncCrewmate(taskId, rootSetAppState, stopReason, registration)
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
      enqueueCrewmateNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
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
      enqueueCrewmateNotification({
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
    try {
      clearInvokedSkillsForAgent(syncAgentId)
    } catch (error) {
      logForDebugging(`foreground agent: backgrounded cleanup failed: ${errorMessage(error)}`)
    }
  }
}

function asyncLaunchedAnswer(needs: { backgroundedTaskId: string; description: string; prompt: string; canReadOutputFile: boolean; modelNote: string | undefined; name: string | undefined; handedByTurnAbort: boolean; sibling: ReturnType<typeof takeSiblingEnd>; task: CrewmateTaskState; detached: Promise<void> }): ForegroundCrewmateResult {
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

function foregroundAnswerOf(needs: { heldError: unknown; seatPause: CrewmatePauseV1 | null; finalized: ReturnType<typeof finalizeCrewmateTool>; prompt: string; agentMessages: Message[]; worktreeFields: WorktreeFields }) {
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

  const data: ForegroundCrewmateResult['data'] =
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

async function attachForegroundEnvelope(needs: { syncAgentId: AgentId; metadata: ForegroundCrewmateMetadata; failureText: string | undefined; finalized: ReturnType<typeof finalizeCrewmateTool>; tracker: ReturnType<typeof createProgressTracker>; data: ForegroundCrewmateResult['data'] }): Promise<void> {
  const { syncAgentId, metadata, failureText, finalized, tracker, data } = needs
  try {
    const [{ buildCrewmateResultEnvelope }, { attachCrewmateEnvelope }] =
      await Promise.all([
        import('../../crew/agent-results/normalize.js'),
        import('../../crew/agent-results/ingest.js'),
      ])
    const envelope = await buildCrewmateResultEnvelope({
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
    attachCrewmateEnvelope(data, envelope)
  } catch (error) {
    passedOver(error)
  }
}

type ForegroundTaskHandle = { taskId: string; abortController: AbortController; backgroundSignal: Promise<void> }

type DetachedNeeds = {
  agentMessages: Message[]; toolUseContext: ToolUseContext; tracker: ReturnType<typeof createProgressTracker>; resolveActivity: ReturnType<typeof createActivityDescriptionResolver>
  rootSetAppState: SetAppState; description: string; metadata: ForegroundCrewmateMetadata; agentIterator: ReturnType<typeof runCrewmate>; backgrounded: boolean
  foregroundTask: ForegroundTaskHandle | undefined; agentStartTime: number; cleanupWorktreeIfNeeded: () => Promise<WorktreeFields>; syncAgentId: AgentId
}

type SeatSettledNeeds = {
  heldError: unknown; agentMessages: Message[]; foregroundTask: ForegroundTaskHandle; rootSetAppState: SetAppState; tracker: ReturnType<typeof createProgressTracker>
  metadata: ForegroundCrewmateMetadata; description: string; toolUseContext: ToolUseContext; agentStartTime: number
}

function foregroundSeatSettled(needs: SeatSettledNeeds): CrewmatePauseV1 | null {
  const { heldError, agentMessages, foregroundTask, rootSetAppState, tracker, metadata, description, toolUseContext, agentStartTime } = needs
  let seatPause: CrewmatePauseV1 | null = null
  const outcome = heldError === undefined ? deriveCrewmateTerminalOutcome(agentMessages) : null
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
  settleCrewmateForeground(foregroundTask.taskId, status, rootSetAppState, getProgressUpdate(tracker), why)
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
        prompt: CREWMATE_WINDOW_RESUME_NOTE,
        summary: `Agent "${description}" resumed by itself — the usage window reset; its partial work carried forward`,
      })
    } else {
      pauseCrewmateTask(foregroundTask.taskId, windowPause, rootSetAppState, foregroundTask.abortController)
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
