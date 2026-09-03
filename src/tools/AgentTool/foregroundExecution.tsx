// The foreground subagent execution machine: the sync message
// loop, the mid-run backgrounding race and handover, progress-summary
// wiring, the SDK task-notification bookend, and worktree cleanup at the
// parent boundary.
//
// Load-bearing subtleties:
//   · the background race promise is built ONCE, outside the loop — a
//     per-iteration .then on the same pending promise would accumulate one
//     reaction per iteration for the agent's whole lifetime;
//   · a backgrounded run settles its task BEFORE any cleanup that can hang
//     (a blocking TaskOutput reader must unblock the moment the task ends);
//   · the foreground iterator close is bounded by a 1000 ms race so a tool
//     in flight cannot wedge the handover;
//   · dump-state and worktree cleanup are guarded by NOT-backgrounded (the
//     backgrounded executor still runs in the worktree and owns the dump).

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
  settleAgentForeground,
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

/** Show the "run in background" hint after this much elapsed time. */
const BACKGROUND_HINT_DELAY_MS = 2_000

/** Bound on waiting for the foreground iterator to close at handover. */
const ITERATOR_CLOSE_TIMEOUT_MS = 1_000

/** The race sentinel the background signal maps onto. */
const BACKGROUNDED = Symbol('foreground-agent-backgrounded')

/** Metadata handed to the shared finalizer (the parameter shape is the
 *  contract — the finalizer reads only startTime and agentType). */
export type ForegroundAgentMetadata = {
  prompt: string
  resolvedAgentModel: string
  isBuiltInAgent: boolean
  startTime: number
  agentType: string
  isAsync: boolean
  /** Structured-output facts for the finalizer (spec 03-C1): present iff a
   *  schema was resolved for this dispatch. */
  structuredSpec?: { mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
}

type WorktreeFields = { worktreePath?: string; worktreeBranch?: string }

/** The three-armed result: a settled foreground run (completed/failed arms
 *  spread the finalizer's record), or the immediate acknowledgement of a
 *  mid-run backgrounding handover. */
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

/**
 * Run one foreground subagent to a settled result — or, when the operator
 * backgrounds it mid-run, hand the remainder to a detached async executor
 * under the same agent id and return the async_launched acknowledgement
 * immediately.
 */
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

  // ── Setup ───────────────────────────────────────────────────────────────
  const agentMessages: Message[] = []
  // The elapsed-time anchor is taken HERE, at execution entry — worktree
  // creation and prompt building sit between the caller's tool-call start
  // and this point (S47).
  const agentStartTime = Date.now()
  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(
    toolUseContext.options.tools,
  )

  // The UI reads the dispatched prompt from the FIRST progress row; every
  // later row carries an empty prompt (no duplication).
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

  // ── Foreground registration ─────────────────────────────────────────────
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
      // The record names the model the agent RUNS — the plan's resolved id
      // (the served id replaces it in the progress fold once a response
      // lands); a record without one painted a model-less row.
      model: metadata.resolvedAgentModel,
      toolUseId: toolUseContext.toolUseId,
      autoBackgroundMs,
    })
    // ONCE, outside the loop (see the header note on reaction buildup).
    backgroundRace = foregroundTask.backgroundSignal.then(() => BACKGROUNDED)
  }

  // ── Summarization ───────────────────────────────────────────────────────
  // The SDK-summaries gate is read LIVE at each decision site (S47).
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

  // ── The backgrounded continuation (detached at the transition) ──────────
  const continueInBackground = async (
    backgroundedTaskId: string,
    taskAbortController: AbortController | undefined,
  ): Promise<void> => {
    let stopBackgroundedSummarization: (() => void) | undefined
    try {
      // (a) Close the foreground iterator so its finally releases MCP
      // connections, session hooks, and prompt-cache tracking. The close
      // waits behind any in-flight next(), so it is bounded by a race; a
      // rejection is swallowed.
      try {
        await Promise.race([
          agentIterator.return(undefined),
          sleep(ITERATOR_CLOSE_TIMEOUT_MS),
        ])
      } catch {
        // swallowed — the close is best-effort
      }

      // (b) Rebuild a tracker and replay the already-yielded messages through it
      // so the backgrounded counts continue from the foreground phase.
      const bgTracker = createProgressTracker()
      for (const replayed of agentMessages) {
        updateProgressFromMessage(
          bgTracker,
          replayed,
          resolveActivity,
          toolUseContext.options.tools,
        )
      }

      // (c) Re-run the agent as an async executor under the backgrounded
      // task id, on the task's own abort controller, with backgrounded
      // summarization under the same gate (its OWN stop function).
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

      // (d) Collect, track, publish to the task, and emit task progress.
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

      // (e) Clean end: finalize, settle the task FIRST (before anything
      // that can hang), then worktree, then the notification.
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

      // Worktree BEFORE the notification so the notification carries it.
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
        // envelope construction must never break completion
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
        // (f) Kill the task FIRST, then the worktree, then notify.
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
      // (g) Fail the task, then the worktree, then notify.
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
      // (h) Stop the backgrounded summarizer and clear the SYNC agent's
      // invoked-skills and prompt-dump state.
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

  // ── The loop ────────────────────────────────────────────────────────────
  let backgrounded = false
  let hintShown = false
  let heldError: unknown
  // The worktree finalizer is ONE-SHOT: its fields are captured at the
  // finally-path call and spread into the result arms.
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
            // ── The backgrounding transition ────────────────────────────
            backgrounded = true
            stopForegroundSummarization?.()
            const backgroundedTaskId = foregroundTask.taskId
            const taskAbortController = task.abortController
            // Detached: the workload context is inherited via ALS at
            // void-invocation time.
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
          // The signal fired without a backgrounded task record: fall
          // through to the already-created next() (never spin the race).
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
        // The task record is the ONE record every crew surface reads (the
        // work roster projects it): the tracker's totals — tool uses, the
        // ledger fold, the served model — land on it at every assistant
        // message, exactly as the background path publishes. This publish
        // once rode the SDK-summaries gate, so a foreground agent's row
        // carried no model and no tokens for the whole of its run.
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
          // The SDK's tool_progress path: forwarded verbatim.
          onProgress?.({ toolUseID: message.toolUseID, data })
        }
        continue
      }
      if (message.type !== 'assistant' && message.type !== 'user') continue

      if (message.type === 'assistant') {
        // Completed messages are the count source (subagent streaming is
        // filtered upstream).
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
      if (backgrounded) {
        // The hand-off: the background task carries on under the same id.
        unregisterAgentForeground(foregroundTask.taskId, rootSetAppState)
      } else {
        // The SDK bookend: ONE terminal event, its status DERIVED over the
        // agentMessages messages (the one-derivation law — the bookend and the
        // parent transcript can never disagree).
        const status: 'completed' | 'failed' | 'stopped' =
          heldError instanceof AbortError
            ? 'stopped'
            : heldError !== undefined
              ? 'failed'
              : deriveAgentTerminalOutcome(agentMessages).status
        // The record SETTLES with its final fold (the same word the bookend
        // carries) and stays through the panel grace — the crew surfaces read
        // the landing; it never vanishes at the settle.
        settleAgentForeground(foregroundTask.taskId, status, rootSetAppState, getProgressUpdate(tracker))
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

  // ── Result assembly ─────────────────────────────────────────────────────
  // An interrupt surfaces as a synthetic conversational tail.
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

  // The parent-boundary envelope rides the WeakMap side-channel; its
  // construction never breaks the result.
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
    // swallowed — the envelope is best-effort
  }

  return { data }
}
