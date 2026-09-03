
import {
  clearInvokedSkillsForAgent,
  getSdkAgentProgressSummariesEnabled,
} from '../../bootstrap/state.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import {
  completeAgentTask,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  registerAgentForeground,
  unregisterAgentForeground,
  updateAgentProgress,
  updateProgressFromMessage,
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
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  extractTextContent,
  isSyntheticMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  normalizeMessages,
} from '../../utils/messages.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import { sleep } from '../../utils/sleep.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getAssistantMessageContentLength } from '../../utils/tokens.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { BackgroundHint } from '../BashTool/UI.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import {
  deriveAgentTerminalOutcome,
  emitTaskProgress,
  extractPartialResult,
  finalizeAgentTool,
  getLastToolUseName,
  PROMOTED_NARRATION_NOTE,
  type AgentToolResult,
} from './agentToolUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { runAgent, type RunAgentParams } from './runAgent.js'

const BACKGROUND_HINT_DELAY_MS = 2_000

const ITERATOR_CLOSE_TIMEOUT_MS = 1_000

const BACKGROUNDED = Symbol('foreground-agent-backgrounded')

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
      }
}

type ForegroundAgentExecutionInput = {
  runAgentParams: RunAgentParams
  promptMessages: Message[]
  prompt: string
  description: string
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
  autoBackgroundMs?: number
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
    autoBackgroundMs,
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
        backgroundSignal: Promise<void>
        cancelAutoBackground?: () => void
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
      autoBackgroundMs,
    })
    backgroundRace = foregroundTask.backgroundSignal.then(() => BACKGROUNDED)
  }

  const foregroundTaskId = foregroundTask?.taskId
  let stopForegroundSummarization: (() => void) | undefined

  const agentIterator = runAgent({
    ...runAgentParams,
    override: { ...runAgentParams.override, agentId: syncAgentId },
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

  const continueInBackground = async (
    backgroundedTaskId: string,
    taskAbortController: AbortController | undefined,
  ): Promise<void> => {
    let stopBackgroundedSummarization: (() => void) | undefined
    try {
      try {
        await Promise.race([
          agentIterator.return(undefined),
          sleep(ITERATOR_CLOSE_TIMEOUT_MS),
        ])
      } catch {
      }

      const bgTracker = createProgressTracker()
      for (const replayed of agentMessages) {
        updateProgressFromMessage(
          bgTracker,
          replayed,
          resolveActivity,
          toolUseContext.options.tools,
        )
      }

      const stream = runAgent({
        ...runAgentParams,
        isAsync: true,
        override: {
          ...runAgentParams.override,
          agentId: backgroundedTaskId,
          ...(taskAbortController
            ? { abortController: taskAbortController }
            : {}),
        },
        ...(getSdkAgentProgressSummariesEnabled()
          ? {
              onCacheSafeParams: (params: CacheSafeParams) => {
                const { stop } = startAgentSummarization(
                  backgroundedTaskId,
                  backgroundedTaskId,
                  params,
                  rootSetAppState,
                )
                stopBackgroundedSummarization = stop
              },
            }
          : {}),
      })

      for await (const message of stream) {
        agentMessages.push(message)
        updateProgressFromMessage(
          bgTracker,
          message,
          resolveActivity,
          toolUseContext.options.tools,
        )
        updateAgentProgress(backgroundedTaskId, getProgressUpdate(bgTracker), rootSetAppState)
        const lastToolName = getLastToolUseName(message)
        if (lastToolName) {
          emitTaskProgress(
            bgTracker,
            backgroundedTaskId,
            toolUseContext.toolUseId,
            description,
            metadata.startTime,
            lastToolName,
          )
        }
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
              totalTokens: getTokenCountFromTracker(bgTracker),
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
        ...(declined ? { error: declined.error } : {}),
        setAppState: rootSetAppState,
        finalMessage,
        usage: {
          totalTokens: getTokenCountFromTracker(bgTracker),
          toolUses: finalized.totalToolUseCount,
          durationMs: finalized.totalDurationMs,
        },
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
        ...(envelopeBlock ? { envelopeBlock } : {}),
      })
    } catch (error) {
      if (error instanceof AbortError) {
        killAsyncAgent(backgroundedTaskId, rootSetAppState)
        const worktreeResult = await cleanupWorktreeIfNeeded()
        enqueueAgentNotification({
          taskId: backgroundedTaskId,
          description,
          status: 'killed',
          setAppState: rootSetAppState,
          toolUseId: toolUseContext.toolUseId,
          finalMessage: extractPartialResult(agentMessages),
          ...worktreeResult,
        })
        return
      }
      const failure = errorMessage(error)
      failAsyncAgent(backgroundedTaskId, failure, rootSetAppState)
      const worktreeResult = await cleanupWorktreeIfNeeded()
      enqueueAgentNotification({
        taskId: backgroundedTaskId,
        description,
        status: 'failed',
        error: failure,
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
      })
    } finally {
      stopBackgroundedSummarization?.()
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
  let worktreeFields: WorktreeFields = {}

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
      if (foregroundTask && backgroundRace) {
        const winner = await Promise.race([nextPromise, backgroundRace])
        if (winner === BACKGROUNDED) {
          const task =
            toolUseContext.getAppState().tasks[foregroundTask.taskId]
          if (isLocalAgentTask(task) && task.isBackgrounded) {
            backgrounded = true
            stopForegroundSummarization?.()
            const backgroundedTaskId = foregroundTask.taskId
            const taskAbortController = task.abortController
            void runWithAgentContext(syncAgentContext, () =>
              continueInBackground(backgroundedTaskId, taskAbortController),
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
          updateAgentProgress(
            foregroundTask.taskId,
            getProgressUpdate(tracker),
            rootSetAppState,
          )
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
    stopForegroundSummarization?.()
    if (foregroundTask) {
      unregisterAgentForeground(foregroundTask.taskId, rootSetAppState)
      if (!backgrounded) {
        const status: 'completed' | 'failed' | 'stopped' =
          heldError instanceof AbortError
            ? 'stopped'
            : heldError !== undefined
              ? 'failed'
              : deriveAgentTerminalOutcome(agentMessages).status
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
    foregroundTask?.cancelAutoBackground?.()
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
        ? finalized.outcome.error
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
