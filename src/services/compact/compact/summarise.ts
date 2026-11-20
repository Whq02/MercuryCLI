import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import { continuationOfSentRequest, lastSentRequestFor, runForkedAgent, type CacheSafeParams } from '../../../utils/forkedAgent.js'
import { appendSystemContext } from '../../../utils/api.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { logError } from '../../../utils/log.js'
import { findLastCompactBoundaryIndex, getAssistantMessageText } from '../../../utils/messages.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../../utils/sessionActivity.js'
import { tokenCountWithEstimation } from '../../../utils/tokens.js'
import { isToolSearchEnabled } from '../../../utils/toolSearch.js'
import { sleep } from '../../../utils/sleep.js'
import { LOCAL_WINDOW_REMEDY, localFitRefusalFacts } from '../../providers/local/localCatalogue.js'
import { routedCallModel, settleAssistantTurn } from '../../providers/callModelRouter.js'
import { coldPrefixOf } from '../../providers/streamIdleBudget.js'
import { getRetryDelay } from '../../api/withRetry.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { rosterOwnerFromToolUseContext } from '../../run/resolveOwner.js'
import { FileReadTool } from '../../../tools/FileReadTool/FileReadTool.js'
import { ToolSearchTool } from '../../../tools/ToolSearchTool/ToolSearchTool.js'
import { projectRewoundWindows } from '../checkpointRewind.js'
import { ERROR_MESSAGE_INCOMPLETE_RESPONSE, KEEPALIVE_INTERVAL_MS } from './limits.js'
import { isOverflowAnswer, malformedHistoryRefusalOf, foldRemedyIsHeadless, foldWindowRefusalText, CompactionRefusedForHistoryError } from './refusals.js'
import { ERROR_MESSAGE_FOLD_TIMEOUT, type FoldBound, armFoldBound, foldCutWords, shouldRideCacheSharingFork, recordFoldRoad } from './foldBound.js'
import { createCompactCanUseTool } from './input.js'
import { summaryAnswerFault, summaryRefusedByModel } from './summaryCheck.js'
import { startInterval, stopInterval } from '../../../utils/timers.js'

async function withKeepAlive<T>(context: ToolUseContext, work: () => Promise<T>): Promise<T> {
  let interval: NodeJS.Timeout | null = null
  if (isSessionActivityTrackingActive()) {
    interval = startInterval(() => {
      sendSessionActivitySignal()
      context.setSDKStatus?.('compacting')
    }, KEEPALIVE_INTERVAL_MS)
    interval.unref()
  }
  try {
    return await work()
  } finally {
    if (interval !== null) stopInterval(interval)
  }
}

async function summarizeViaCacheSharingFork(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage | null> {
  const model = context.options.engineModel
  const bound = armFoldBound(context.abortController.signal, 'fork', tokenCountWithEstimation(messages), model, coldPrefixOf(messages, model))
  const startedAt = Date.now()
  try {
    context.setResponseLength?.(() => 0)
    const result = await runForkedAgent({
      promptMessages: [promptMessage],
      cacheSafeParams: { ...cacheSafeParams, toolUseContext: context, forkContextMessages: messages },
      canUseTool: createCompactCanUseTool(),
      querySource: 'compact',
      forkLabel: 'compact',
      maxTurns: 1,
      skipCacheWrite: true,
      onStreamEvent: event => {
        bound.content()
        const inner = event as { type?: string; delta?: { type?: string; text?: string } }
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const length = inner.delta.text?.length ?? 0
          context.setResponseLength?.(prev => prev + length)
        }
      },
      overrides: {
        agentId: context.agentId,
        abortController: bound.controller,
        setSDKStatus: status => {
          if (typeof status === 'object' && status !== null && 'streamActivity' in status) bound.touch()
          context.setSDKStatus?.(status)
        },
        getAppState: () => {
          const state = context.getAppState()
          return state.toolPermissionContext.shouldAvoidPermissionPrompts
            ? state
            : {
                ...state,
                toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
              }
        },
      },
    })
    if (bound.hitDeadline()) {
      const elapsedMs = Date.now() - startedAt
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsedMs} ms mid-stream — its partial output is discarded; handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsedMs} ms (partial output discarded)`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    const last = [...result.messages].reverse().find(message => message.type === 'assistant') as
      | AssistantMessage
      | undefined
    if (last !== undefined && last.isApiErrorMessage !== true) {
      const text = getAssistantMessageText(last)
      if (text !== null && text !== '') {
        recordFoldRoad(model, 'fork', startedAt, 'summary')
        return last
      }
    }
    if (last !== undefined && isOverflowAnswer(last)) {
      recordFoldRoad(model, 'fork', startedAt, 'overflow')
      return last
    }
    if (last !== undefined && summaryRefusedByModel(last)) {
      recordFoldRoad(model, 'fork', startedAt, 'refused')
      return last
    }
    if (last !== undefined) {
      const malformed = malformedHistoryRefusalOf(last)
      if (malformed !== null) {
        recordFoldRoad(model, 'fork', startedAt, 'refused', malformed.slice(0, 160))
        throw new CompactionRefusedForHistoryError(malformed, {
          nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
        })
      }
    }
    logForDebugging(`compact: fork path produced no usable summary: ${JSON.stringify(result.messages).slice(0, 500)}`, {
      level: 'warn',
    })
    recordFoldRoad(model, 'fork', startedAt, 'handover', 'no usable summary')
    return null
  } catch (err) {
    if (err instanceof CompactionRefusedForHistoryError) throw err
    const elapsedMs = Date.now() - startedAt
    if (bound.hitDeadline()) {
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsedMs} ms — handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsedMs} ms`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    logError(err)
    logForDebugging(`compact: fork lane failed after ${elapsedMs} ms — handing over to the direct call: ${err instanceof Error ? err.message : String(err)}`, { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', (err instanceof Error ? err.message : String(err)).slice(0, 160))
    return null
  } finally {
    bound.dispose()
  }
}

async function summarizeViaStreamingFallback(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage> {
  const model = context.options.engineModel
  const bound = armFoldBound(context.abortController.signal, 'direct', tokenCountWithEstimation(messages), model, coldPrefixOf(messages, model))
  const startedAt = Date.now()
  try {
    const settled = await streamingFallbackAttempts(messages, cacheSafeParams, promptMessage, context, bound)
    recordFoldRoad(model, 'direct', startedAt, settled.isApiErrorMessage === true ? 'refused' : 'summary')
    return settled
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === ERROR_MESSAGE_FOLD_TIMEOUT) {
      logForDebugging(`compact: direct lane cut for ${foldCutWords(bound)} after ${Date.now() - startedAt} ms — nothing folded`, { level: 'warn' })
    }
    recordFoldRoad(
      model,
      'direct',
      startedAt,
      message === ERROR_MESSAGE_FOLD_TIMEOUT
        ? 'timeout'
        : message === ERROR_MESSAGE_INCOMPLETE_RESPONSE
          ? 'incomplete'
          : context.abortController.signal.aborted || err instanceof APIUserAbortError
            ? 'aborted'
            : 'refused',
      message.slice(0, 160),
    )
    throw err
  } finally {
    bound.dispose()
  }
}

async function streamingFallbackAttempts(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  bound: FoldBound,
): Promise<AssistantMessage> {
  const attempts = 1
  const model = context.options.engineModel
  let streamingStarted = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    streamingStarted = false
    context.setResponseLength?.(() => 0)
    const toolSearchEnabled = await isToolSearchEnabled(
      model,
      context.options.tools,
      () => Promise.resolve(context.getAppState().toolPermissionContext),
      context.options.agentDefinitions.activeAgents,
      'compact',
    )
    const toolMap = new Map<string, (typeof context.options.tools)[number]>()
    for (const tool of context.options.tools) {
      if (!toolMap.has(tool.name)) toolMap.set(tool.name, tool)
    }
    if (toolMap.size === 0) {
      toolMap.set(FileReadTool.name, FileReadTool)
      if (toolSearchEnabled) toolMap.set(ToolSearchTool.name, ToolSearchTool)
    }
    const tools = [...toolMap.values()]

    const afterBoundary = (() => {
      const index = findLastCompactBoundaryIndex(messages)
      const sliced = index >= 0 ? messages.slice(index + 1) : messages
      return projectRewoundWindows(sliced)
    })()
    const continuation = continuationOfSentRequest(
      lastSentRequestFor(String(rosterOwnerFromToolUseContext(context))),
      afterBoundary,
    )
    if (continuation !== null && attempt === 1) {
      logForDebugging(
        `compact: direct lane re-sends the session's last request (${continuation.sent.length} rows) + ${continuation.tail.length} newer row(s) + the prompt`,
      )
    }
    const apiMessages: Message[] = continuation !== null
      ? [...continuation.sent, ...continuation.tail, promptMessage]
      : [...afterBoundary, promptMessage]

    let captured: AssistantMessage | undefined
    const settled: AssistantMessage[] = []
    bound.request()
    const stream = routedCallModel({
      messages: apiMessages,
      systemPrompt: asSystemPrompt(appendSystemContext([...cacheSafeParams.systemPrompt], cacheSafeParams.systemContext ?? {}, model)),
      thinkingConfig: context.options.thinkingConfig,
      tools,
      signal: bound.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(context.getAppState().toolPermissionContext),
        model,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: Boolean(context.options.appendSystemPrompt),
        querySource: 'compact',
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        effortValue: context.getAppState().effortValue,
        agentId: context.agentId,
        onWait: wait => context.setSDKStatus?.({ wait }),
        onStreamActivity: atMs => {
          bound.touch()
          context.setSDKStatus?.({ streamActivity: atMs })
        },
        ownerKey: String(rosterOwnerFromToolUseContext(context)),
      },
    })
    try {
      for await (const event of stream) {
        bound.content()
        if (event.type === 'stream_event') {
          const inner = event.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } }
          if (inner.type === 'content_block_start' && inner.content_block?.type === 'text') {
            streamingStarted = true
            context.setStreamMode?.('responding')
          }
          if (inner.type === 'content_block_delta' && (inner.delta?.type === 'text_delta' || inner.delta?.type === 'thinking_delta')) {
            const length = (inner.delta.type === 'thinking_delta' ? inner.delta.thinking : inner.delta.text)?.length ?? 0
            context.setResponseLength?.(prev => prev + length)
          }
        } else if (event.type === 'assistant') {
          captured = event
          settled.push(event)
        }
      }
    } catch (err) {
      if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
      throw err
    }
    if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
    if (bound.signal.aborted) throw new APIUserAbortError()
    if (captured?.isApiErrorMessage === true) {
      if (summaryAnswerFault(captured) !== null) return captured
      if (!isOverflowAnswer(captured) && !summaryRefusedByModel(captured)) {
        const malformed = malformedHistoryRefusalOf(captured)
        if (malformed !== null) {
          throw new CompactionRefusedForHistoryError(malformed, {
            nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
          })
        }
        const fit = localFitRefusalFacts(getAssistantMessageText(captured) ?? '')
        if (fit !== null) {
          throw new Error(foldWindowRefusalText({ window: fit.window, sourceWords: fit.sourceWords, estTokens: fit.estTokens, remedy: LOCAL_WINDOW_REMEDY }))
        }
        throw new Error(getAssistantMessageText(captured) ?? ERROR_MESSAGE_INCOMPLETE_RESPONSE)
      }
    }
    if (captured !== undefined) return captured.isApiErrorMessage ? captured : settleAssistantTurn(settled, false)
    if (attempt < attempts) {
      await sleep(getRetryDelay(attempt), bound.signal).catch(() => {
        if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
        throw new APIUserAbortError()
      })
      continue
    }
    logForDebugging(
      `compact: streaming fallback produced no response after ${attempts} attempt(s) (streaming started: ${streamingStarted})`,
      { level: 'error' },
    )
  }
  throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
}

export async function runSummarization(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  directOnly = false,
): Promise<AssistantMessage> {
  return withKeepAlive(context, async () => {
    if (
      !directOnly &&
      shouldRideCacheSharingFork(context.options.engineModel, context.options.thinkingConfig)
    ) {
      const viaFork = await summarizeViaCacheSharingFork(messages, cacheSafeParams, promptMessage, context)
      if (viaFork !== null) return viaFork
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
    }
    return summarizeViaStreamingFallback(messages, cacheSafeParams, promptMessage, context)
  })
}
