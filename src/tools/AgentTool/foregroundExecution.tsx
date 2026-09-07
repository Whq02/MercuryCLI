
import {
  clearInvokedSkillsForAgent,
  getSdkAgentProgressSummariesEnabled,
} from '../../bootstrap/state.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
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
  pauseAgentTask,
  publishAgentProgressSoon,
  publishAgentWaitFromEvent,
  registerAgentForeground,
  registerAgentName,
  settleAgentForeground,
  takeSiblingEnd,
  unregisterAgentForeground,
  updateAgentProgress,
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
import { AbortError, errorMessage } from '../../utils/errors.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { pauseLineWords, type AgentPauseV1 } from '../../tasks/LocalAgentTask/agentPause.js'
import {
  extractTextContent,
  isSyntheticMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  normalizeMessages,
} from '../../utils/messages.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getAssistantMessageContentLength } from '../../utils/tokens.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { BackgroundHint } from '../BashTool/UI.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import {
  deriveAgentTerminalOutcome,
  emitTaskProgress,
  armBudgetCutResume,
  extractPartialResult,
  partialResultEnvelopeBlock,
  budgetCutResumeDelayMs,
  recoveryBudgetCutOf,
  finalizeAgentTool,
  getLastToolUseName,
  landedWritesOf,
  PROMOTED_NARRATION_NOTE,
  type AgentToolResult,
  REPETITION_STOP_WORDS,
} from './agentToolUtils.js'
import type { BackgroundHandoverReason } from '../../tasks/LocalAgentTask/launchReceipts.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { runAgent, type RunAgentParams } from './runAgent.js'

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

export type ForegroundAgentResult = {
  data:
    | (AgentToolResult & { status: 'completed'; prompt: string } & WorktreeFields)
    | (AgentToolResult & {
        status: 'failed'
        error: string
        prompt: string
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
  const agentStartTime = Date.now()
  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(
    toolUseContext.options.tools,
  )

  const progressToolUseId = `agent_${assistantMessage.message.id}`
  const normalizedPromptUser = normalizeMessages(promptMessages).find(
    (message): message is NormalizedUserMessage => message.type === 'user',
  )
  if (normalizedPromptUser) {
    onProgress?.({
      toolUseID: progressToolUseId,
      data: {
        type: 'agent_progress',
        message: normalizedPromptUser,
        prompt,
        agentId: syncAgentId,
      },
    })
  }

  let foregroundTask:
    | {
        taskId: string
        abortController: AbortController
        backgroundSignal: Promise<void>
      }
    | undefined
  let backgroundRace: Promise<typeof BACKGROUNDED> | undefined
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
    backgroundRace = foregroundTask.backgroundSignal.then(() => BACKGROUNDED)
    if (name !== undefined) registerAgentName(name, syncAgentId, rootSetAppState)
  }

  const foregroundTaskId = foregroundTask?.taskId
  let stopForegroundSummarization: (() => void) | undefined

  const foregroundRecordId = foregroundTask?.taskId
  const agentIterator = runAgent({
    ...runAgentParams,
    override: {
      ...runAgentParams.override,
      agentId: syncAgentId,
      ...(foregroundTask !== undefined ? { abortController: foregroundTask.abortController } : {}),
    },
    ...(foregroundRecordId !== undefined
      ? { onQueryProgress: (event: unknown) => publishAgentWaitFromEvent(foregroundRecordId, tracker, event, rootSetAppState) }
      : {}),
    ...(foregroundTaskId !== undefined && getSdkAgentProgressSummariesEnabled()
      ? {
          onCacheSafeParams: (params: CacheSafeParams) => {
            const { stop } = startAgentSummarization(
              foregroundTaskId,
              syncAgentId,
              params,
              rootSetAppState,
            )
            stopForegroundSummarization = stop
          },
        }
      : {}),
  })

  const continueDetached = async (
    backgroundedTaskId: string,
    pending: Promise<IteratorResult<Message, void>>,
  ): Promise<void> => {
    try {
      let step = await pending
      while (!step.done) {
        const message = step.value
        agentMessages.push(message)
        updateProgressFromMessage(
          tracker,
          message,
          resolveActivity,
          toolUseContext.options.tools,
        )
        publishAgentProgressSoon(backgroundedTaskId, tracker, rootSetAppState)
        const lastToolName = getLastToolUseName(message)
        if (lastToolName) {
          emitTaskProgress(
            tracker,
            backgroundedTaskId,
            toolUseContext.toolUseId,
            description,
            metadata.startTime,
            lastToolName,
          )
        }
        step = await agentIterator.next()
      }

      const finalized = finalizeAgentTool(agentMessages, backgroundedTaskId, metadata)
      const declined =
        finalized.outcome?.status === 'failed' ? finalized.outcome : undefined
      if (declined) {
        failAsyncAgent(backgroundedTaskId, declined.error, rootSetAppState)
      } else {
        completeAgentTask(finalized, rootSetAppState)
      }

      let finalMessage = extractTextContent(finalized.content, '\n')
      if (
        finalized.outcome?.status === 'completed' &&
        finalized.outcome.promotedNarration &&
        finalMessage
      ) {
        finalMessage = `${PROMOTED_NARRATION_NOTE}\n${finalMessage}`
      }

      const worktreeResult = await cleanupWorktreeIfNeeded()

      let envelopeBlock: string | undefined
      try {
        const { buildAgentResultEnvelope, formatEnvelopeBlock } = await import(
          '../../services/agentResults/normalize.js'
        )
        envelopeBlock = formatEnvelopeBlock(
          await buildAgentResultEnvelope({
            agentId: String(backgroundedTaskId),
            agentType: metadata.agentType,
            status: declined ? 'failed' : 'completed',
            finalText: finalMessage ?? '',
            usage: {
              totalTokens: getTokenCountFromTracker(tracker),
              toolUseCount: finalized.totalToolUseCount,
              durationMs: finalized.totalDurationMs,
            },
          }),
        )
      } catch {
      }

      enqueueAgentNotification({
        taskId: backgroundedTaskId,
        description,
        status: declined ? 'failed' : 'completed',
        ...(declined ? { error: declined.error, landedWrites: landedWritesOf(agentMessages) } : {}),
        setAppState: rootSetAppState,
        finalMessage,
        usage: {
          totalTokens: getTokenCountFromTracker(tracker),
          toolUses: finalized.totalToolUseCount,
          durationMs: finalized.totalDurationMs,
        },
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
        ...(envelopeBlock ? { envelopeBlock } : {}),
      })
    } catch (error) {
      if (error instanceof AbortError) {
        const stopReason = agentStopReasonOf(foregroundTask?.abortController.signal.reason)
        killAsyncAgent(backgroundedTaskId, rootSetAppState, stopReason)
        const worktreeResult = await cleanupWorktreeIfNeeded()
        await flushSessionStorage()
        const partialResult = extractPartialResult(agentMessages)
        const usage = {
          totalTokens: getTokenCountFromTracker(tracker),
          toolUses: tracker.toolUseCount,
          durationMs: Date.now() - agentStartTime,
        }
        const envelopeBlock = await partialResultEnvelopeBlock({
          agentId: String(backgroundedTaskId),
          agentType: metadata.agentType,
          status: 'stopped',
          partialText: partialResult,
          usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs },
        })
        enqueueAgentNotification({
          taskId: backgroundedTaskId,
          description,
          status: 'killed',
          setAppState: rootSetAppState,
          toolUseId: toolUseContext.toolUseId,
          finalMessage: partialResult,
          usage,
          landedWrites: landedWritesOf(agentMessages),
          ...(stopReason !== undefined ? { stopReason } : {}),
          ...worktreeResult,
          ...(envelopeBlock ? { envelopeBlock } : {}),
        })
        return
      }
      const failure = errorMessage(error)
      failAsyncAgent(backgroundedTaskId, failure, rootSetAppState)
      const worktreeResult = await cleanupWorktreeIfNeeded()
      await flushSessionStorage()
      const partialResult = extractPartialResult(agentMessages)
      const usage = {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: tracker.toolUseCount,
        durationMs: Date.now() - agentStartTime,
      }
      const envelopeBlock = await partialResultEnvelopeBlock({
        agentId: String(backgroundedTaskId),
        agentType: metadata.agentType,
        status: 'failed',
        partialText: partialResult,
        usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs },
      })
      enqueueAgentNotification({
        taskId: backgroundedTaskId,
        description,
        status: 'failed',
        error: failure,
        finalMessage: partialResult,
        usage,
        landedWrites: landedWritesOf(agentMessages),
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
        ...(envelopeBlock ? { envelopeBlock } : {}),
      })
      const budgetCut = recoveryBudgetCutOf(error)
      if (budgetCut !== null && foregroundTask !== undefined) {
        const delayMs = budgetCutResumeDelayMs(budgetCut)
        armBudgetCutResume({
          taskId: backgroundedTaskId,
          description,
          registration: foregroundTask.abortController,
          toolUseContext,
          rootSetAppState,
          delayMs,
          pause: { why: 'provider busy', words: budgetCut.words, resumesAtMs: Date.now() + delayMs },
        })
      }
    } finally {
      stopForegroundSummarization?.()
      try {
        clearInvokedSkillsForAgent(syncAgentId)
        clearDumpState(syncAgentId)
      } catch (error) {
        logForDebugging(
          `foreground agent: backgrounded cleanup failed: ${errorMessage(error)}`,
        )
      }
    }
  }

  let backgrounded = false
  let hintShown = false
  let heldError: unknown
  let seatPause: AgentPauseV1 | null = null
  let worktreeFields: WorktreeFields = {}

  const turnSignal = toolUseContext.abortController.signal
  let onTurnAbort: (() => void) | undefined
  const turnAbortRace: Promise<typeof TURN_ABORTED> | undefined = foregroundTask
    ? new Promise<typeof TURN_ABORTED>(resolve => {
        if (turnSignal.aborted) {
          resolve(TURN_ABORTED)
          return
        }
        onTurnAbort = () => resolve(TURN_ABORTED)
        turnSignal.addEventListener('abort', onTurnAbort, { once: true })
      })
    : undefined

  try {
    while (true) {
      if (
        !hintShown &&
        Date.now() - agentStartTime >= BACKGROUND_HINT_DELAY_MS &&
        toolUseContext.setToolJSX
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
      if (foregroundTask && backgroundRace && turnAbortRace) {
        let winner = await Promise.race([nextPromise, backgroundRace, turnAbortRace])
        const handedByTurnAbort = winner === TURN_ABORTED
        if (winner === TURN_ABORTED) {
          backgroundAgentTask(foregroundTask.taskId, toolUseContext.getAppState, rootSetAppState)
          winner = BACKGROUNDED
        }
        if (winner === BACKGROUNDED) {
          const task =
            toolUseContext.getAppState().tasks[foregroundTask.taskId]
          if (isLocalAgentTask(task) && task.isBackgrounded) {
            backgrounded = true
            const backgroundedTaskId = foregroundTask.taskId
            const sibling = takeSiblingEnd(backgroundedTaskId)
            void runWithAgentContext(syncAgentContext, () =>
              continueDetached(backgroundedTaskId, nextPromise),
            )
            const canReadOutputFile = toolUseContext.options.tools.some(
              tool =>
                toolMatchesName(tool, FILE_READ_TOOL_NAME) ||
                toolMatchesName(tool, BASH_TOOL_NAME),
            )
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
                backgroundReason: handedByTurnAbort ? 'turn-interrupted' : sibling !== null ? 'sibling-ended' : 'backgrounded',
                ...(sibling !== null && !handedByTurnAbort ? { siblingEnd: sibling } : {}),
              },
            }
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
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      if (foregroundTask) {
        if (message.type === 'assistant') {
          publishAgentProgressSoon(foregroundTask.taskId, tracker, rootSetAppState)
        }
        const lastToolName = getLastToolUseName(message)
        if (lastToolName) {
          emitTaskProgress(
            tracker,
            foregroundTask.taskId,
            toolUseContext.toolUseId,
            description,
            metadata.startTime,
            lastToolName,
          )
        }
      }

      if (message.type === 'progress') {
        const data = message.data
        if (
          data.type === 'bash_progress' ||
          data.type === 'powershell_progress'
        ) {
          onProgress?.({ toolUseID: message.toolUseID, data })
        }
        continue
      }
      if (message.type !== 'assistant' && message.type !== 'user') continue

      if (message.type === 'assistant') {
        toolUseContext.setResponseLength(
          prev => prev + getAssistantMessageContentLength(message),
        )
      }

      for (const normalized of normalizeMessages([message])) {
        if (
          isToolUseRequestMessage(normalized) ||
          isToolUseResultMessage(normalized)
        ) {
          onProgress?.({
            toolUseID: progressToolUseId,
            data: {
              type: 'agent_progress',
              message: normalized,
              prompt: '',
              agentId: syncAgentId,
            },
          })
        }
      }
    }
  } catch (error) {
    heldError = error
    if (error instanceof AbortError) throw error
    logForDebugging(`Sync agent error: ${errorMessage(error)}`, {
      level: 'error',
    })
  } finally {
    toolUseContext.setToolJSX?.(null)
    if (onTurnAbort !== undefined) turnSignal.removeEventListener('abort', onTurnAbort)
    if (!backgrounded) stopForegroundSummarization?.()
    if (foregroundTask) {
      if (backgrounded) {
        unregisterAgentForeground(foregroundTask.taskId, rootSetAppState)
      } else {
        const outcome = heldError === undefined ? deriveAgentTerminalOutcome(agentMessages) : null
        const status: 'completed' | 'failed' | 'stopped' =
          heldError instanceof AbortError
            ? 'stopped'
            : heldError !== undefined
              ? 'failed'
              : outcome!.status
        const why =
          outcome !== null && outcome.status === 'failed'
            ? { error: outcome.error, ...(outcome.reason === 'repetition-stop' ? { stopReason: REPETITION_STOP_WORDS } : {}) }
            : status === 'failed' && heldError !== undefined
              ? { error: errorMessage(heldError) }
              : undefined
        settleAgentForeground(foregroundTask.taskId, status, rootSetAppState, getProgressUpdate(tracker), why)
        const windowPause = outcome !== null && outcome.status === 'failed' ? usageWindowPauseOf(agentMessages, metadata.resolvedAgentModel) : null
        seatPause = windowPause
        if (windowPause !== null) {
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
        enqueueSdkEvent({
          type: 'system',
          subtype: 'task_notification',
          task_id: foregroundTask.taskId,
          ...(toolUseContext.toolUseId !== undefined
            ? { tool_use_id: toolUseContext.toolUseId }
            : {}),
          status,
          output_file: '',
          summary: description,
          usage: {
            total_tokens: getTokenCountFromTracker(tracker),
            tool_uses: tracker.toolUseCount,
            duration_ms: Date.now() - agentStartTime,
          },
        })
      }
    }
    clearInvokedSkillsForAgent(syncAgentId)
    if (!backgrounded) clearDumpState(syncAgentId)
    if (!backgrounded) worktreeFields = await cleanupWorktreeIfNeeded()
  }

  let lastConversational: Message | undefined
  for (let index = agentMessages.length - 1; index >= 0; index--) {
    const message = agentMessages[index]!
    if (message.type === 'system' || message.type === 'progress') continue
    lastConversational = message
    break
  }
  if (lastConversational && isSyntheticMessage(lastConversational)) {
    throw new AbortError()
  }

  if (heldError !== undefined) {
    const hasAssistantMessages = agentMessages.some(
      message => message.type === 'assistant',
    )
    if (!hasAssistantMessages) throw heldError
    logForDebugging(
      `Sync agent recovered with partial output: ${errorMessage(heldError)}`,
    )
  }

  const finalized = finalizeAgentTool(agentMessages, syncAgentId, metadata)
  const failureText =
    heldError !== undefined
      ? errorMessage(heldError)
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
          ...finalized,
          ...worktreeFields,
        }
      : { status: 'completed', prompt, ...finalized, ...worktreeFields }

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
  } catch {
  }

  return { data }
}
