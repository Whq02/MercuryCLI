import type { Tool, ToolUseContext } from '../../../tools/kit/tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { continuationOfSentRequest, lastSentRequestFor, runForkedAgent, type CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import { appendSystemContext } from '../../messages/apiSystemAndToolSchema.js'
import { asSystemPrompt } from '../../system-prompt/systemPromptType.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { isRecord } from '../../../platform/primitives/isRecord.js'
import { findLastFoldBoundaryIndex, getAssistantMessageText } from '../../messages/messages.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../requests/sessionActivity.js'
import { tokenCountWithEstimation } from '../../context-window/contextTokenCount.js'
import { isToolSearchEnabled } from '../../messages/toolSearch.js'
import { LOCAL_WINDOW_REMEDY, localFitRefusalFacts } from '../../../models/roads/local/localCatalogue.js'
import { routedCallModel, settleAssistantTurn } from '../../../models/roads/callModelRouter.js'
import { coldPrefixOf } from '../../../models/roads/streamIdleBudget.js'
import { APIUserAbortError } from '../../request-parts/sdkErrors.js'
import { rosterOwnerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import { ReadTool } from '../../../tools/read/ReadTool.js'
import { ToolSearchTool } from '../../../tools/tool-search/ToolSearchTool.js'
import { projectRewoundWindows } from '../checkpointRewind.js'
import { ERROR_MESSAGE_INCOMPLETE_RESPONSE, KEEPALIVE_INTERVAL_MS } from './foldLimits.js'
import { isOverflowAnswer, malformedHistoryRefusalOf, foldRemedyIsHeadless, foldWindowRefusalText, FoldRefusedForHistoryError } from './refusals.js'
import { ERROR_MESSAGE_FOLD_TIMEOUT, type FoldBound, armFoldBound, foldCutWords, shouldRideCacheSharingFork, recordFoldRoad } from './foldBound.js'
import { createFoldCanUseTool } from './summariserInput.js'
import { summaryAnswerFault, summaryRefusedByModel } from './summaryCheck.js'
import { startInterval, stopInterval } from '../../../platform/async/timers.js'

async function summarizeViaCacheSharingFork(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage | null> {
  const model = context.options.engineModel
  const startedAt = Date.now()
  const estTokens = tokenCountWithEstimation(messages)
  const cold = coldPrefixOf(messages, model)
  const bound = armFoldBound(context.abortController.signal, 'fork', estTokens, model, cold)
  context.setResponseLength?.(() => 0)
  try {
    const getAppState = () => {
      const state = context.getAppState()
      if (state.toolPermissionContext.shouldAvoidPermissionPrompts === true) return state
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          shouldAvoidPermissionPrompts: true,
        },
      }
    }
    const setSDKStatus = (status: unknown): void => {
      if (isRecord(status) && Object.hasOwn(status, 'streamActivity')) bound.touch()
      context.setSDKStatus?.(status)
    }
    const result = await runForkedAgent({
      promptMessages: [promptMessage],
      cacheSafeParams: {
        ...cacheSafeParams,
        toolUseContext: context,
        forkContextMessages: messages,
      },
      canUseTool: createFoldCanUseTool(),
      querySource: 'compact',
      forkLabel: 'compact',
      maxTurns: 1,
      skipCacheWrite: true,
      onStreamEvent: event => {
        bound.content()
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const len = event.delta.text.length
          context.setResponseLength?.(prev => prev + len)
        }
      },
      overrides: {
        agentId: context.agentId,
        abortController: bound.controller,
        setSDKStatus,
        getAppState,
      },
    })
    if (bound.hitDeadline()) {
      const elapsed = Date.now() - startedAt
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsed} ms mid-stream — its partial output is discarded; handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsed} ms (partial output discarded)`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    let lastAssistant: AssistantMessage | undefined
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const msg = result.messages[i]
      if (msg?.type === 'assistant') {
        lastAssistant = msg
        break
      }
    }
    if (lastAssistant !== undefined) {
      if (lastAssistant.isApiErrorMessage !== true && (getAssistantMessageText(lastAssistant) ?? '').trim().length > 0) {
        recordFoldRoad(model, 'fork', startedAt, 'summary')
        return lastAssistant
      }
      if (isOverflowAnswer(lastAssistant)) {
        recordFoldRoad(model, 'fork', startedAt, 'overflow')
        return lastAssistant
      }
      if (summaryRefusedByModel(lastAssistant)) {
        recordFoldRoad(model, 'fork', startedAt, 'refused')
        return lastAssistant
      }
      const malformed = malformedHistoryRefusalOf(lastAssistant)
      if (malformed !== null) {
        recordFoldRoad(model, 'fork', startedAt, 'refused')
        throw new FoldRefusedForHistoryError(malformed, {
          nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
        })
      }
    }
    logForDebugging(`compact: fork path produced no usable summary: ${JSON.stringify(result.messages).slice(0, 500)}`, { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', 'no usable summary')
    return null
  } catch (error) {
    if (error instanceof FoldRefusedForHistoryError) throw error
    const elapsed = Date.now() - startedAt
    if (bound.hitDeadline()) {
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsed} ms — handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsed} ms`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    logError(error)
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`compact: fork lane failed after ${elapsed} ms — handing over to the direct call: ${message}`, { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', message.slice(0, 160))
    return null
  } finally {
    bound.dispose()
  }
}

function throwIfDirectLaneCut(bound: FoldBound): void {
  if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
  if (bound.signal.aborted) throw new APIUserAbortError()
}

async function summarizeDirect(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage> {
  const model = context.options.engineModel
  const startedAt = Date.now()
  const estTokens = tokenCountWithEstimation(messages)
  const cold = coldPrefixOf(messages, model)
  const bound = armFoldBound(context.abortController.signal, 'direct', estTokens, model, cold)
  context.setResponseLength?.(() => 0)
  try {
    const getToolPermissionContext = async () => context.getAppState().toolPermissionContext
    const activeAgents = context.options.agentDefinitions?.activeAgents ?? []
    const toolSearchOn = await isToolSearchEnabled(
      model,
      context.options.tools,
      getToolPermissionContext,
      activeAgents,
      'compact',
    )
    const seenTools = new Set<string>()
    const dedupedTools: Tool[] = []
    for (const tool of context.options.tools) {
      if (seenTools.has(tool.name)) continue
      seenTools.add(tool.name)
      dedupedTools.push(tool)
    }
    const tools =
      dedupedTools.length > 0
        ? dedupedTools
        : toolSearchOn
          ? [ReadTool, ToolSearchTool]
          : [ReadTool]

    const boundaryIndex = findLastFoldBoundaryIndex(messages)
    const afterBoundary = boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages
    const projected = projectRewoundWindows(afterBoundary)
    const ownerKey = String(rosterOwnerFromToolUseContext(context))
    const continuation = continuationOfSentRequest(lastSentRequestFor(ownerKey), projected)
    const requestMessages: Message[] =
      continuation !== null
        ? [...continuation.sent, ...continuation.tail, promptMessage]
        : [...projected, promptMessage]
    if (continuation !== null) {
      logForDebugging(`compact: direct lane re-sends the session's last request (${continuation.sent.length} rows) + ${continuation.tail.length} newer row(s) + the prompt`)
    }

    const systemPrompt = asSystemPrompt(
      appendSystemContext(cacheSafeParams.systemPrompt ?? [], cacheSafeParams.systemContext ?? {}, model),
    )
    const thinkingConfig = context.options.thinkingConfig ?? { type: 'disabled' as const }

    bound.request()
    const stream = routedCallModel({
      messages: requestMessages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal: bound.signal,
      options: {
        getToolPermissionContext,
        model,
        querySource: 'compact',
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
        agents: activeAgents,
        allowedAgentTypes: context.options.agentDefinitions?.allowedAgentTypes,
        mcpTools: [],
        effortValue: context.getAppState().effortValue,
        agentId: context.agentId,
        ownerKey,
        onWait: wait => context.setSDKStatus?.({ wait }),
        onStreamActivity: atMs => {
          bound.touch()
          context.setSDKStatus?.({ streamActivity: atMs })
        },
      },
    })

    const attempts = 1
    let streamingStarted = false
    const assistantMessages: AssistantMessage[] = []
    try {
      for await (const item of stream) {
        bound.content()
        if (item.type === 'stream_event') {
          if (item.event.type === 'content_block_start' && item.event.content_block.type === 'text') {
            streamingStarted = true
            context.setStreamMode?.('responding')
          } else if (item.event.type === 'content_block_delta') {
            if (item.event.delta.type === 'text_delta') {
              const len = item.event.delta.text.length
              context.setResponseLength?.(prev => prev + len)
            } else if (item.event.delta.type === 'thinking_delta') {
              const len = item.event.delta.thinking.length
              context.setResponseLength?.(prev => prev + len)
            }
          }
        } else if (item.type === 'assistant') {
          assistantMessages.push(item)
        }
      }
    } catch (error) {
      throwIfDirectLaneCut(bound)
      throw error
    }
    throwIfDirectLaneCut(bound)

    const captured = assistantMessages.at(-1)
    if (captured === undefined) {
      logForDebugging(`compact: streaming fallback produced no response after ${attempts} attempt(s) (streaming started: ${streamingStarted})`, { level: 'error' })
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    }
    if (captured.isApiErrorMessage !== true) {
      recordFoldRoad(model, 'direct', startedAt, 'summary')
      return settleAssistantTurn(assistantMessages, false)
    }
    if (summaryAnswerFault(captured) !== null || isOverflowAnswer(captured) || summaryRefusedByModel(captured)) {
      recordFoldRoad(model, 'direct', startedAt, 'refused')
      return captured
    }
    const malformed = malformedHistoryRefusalOf(captured)
    if (malformed !== null) {
      throw new FoldRefusedForHistoryError(malformed, {
        nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
      })
    }
    const text = getAssistantMessageText(captured) ?? ''
    const fitFacts = localFitRefusalFacts(text)
    if (fitFacts !== null) {
      throw new Error(
        foldWindowRefusalText({
          window: fitFacts.window,
          sourceWords: fitFacts.sourceWords,
          estTokens: fitFacts.estTokens,
          remedy: LOCAL_WINDOW_REMEDY,
        }),
      )
    }
    throw new Error(text !== '' ? text : ERROR_MESSAGE_INCOMPLETE_RESPONSE)
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    let outcome: 'timeout' | 'incomplete' | 'aborted' | 'refused'
    if (message === ERROR_MESSAGE_FOLD_TIMEOUT) {
      logForDebugging(`compact: direct lane cut for ${foldCutWords(bound)} after ${Date.now() - startedAt} ms — nothing folded`, { level: 'warn' })
      outcome = 'timeout'
    } else if (message === ERROR_MESSAGE_INCOMPLETE_RESPONSE) {
      outcome = 'incomplete'
    } else if (context.abortController.signal.aborted || failure instanceof APIUserAbortError) {
      outcome = 'aborted'
    } else {
      outcome = 'refused'
    }
    recordFoldRoad(model, 'direct', startedAt, outcome, message.slice(0, 160))
    throw failure
  } finally {
    bound.dispose()
  }
}

export async function runSummarization(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  directOnly: boolean = false,
): Promise<AssistantMessage> {
  let keepalive: ReturnType<typeof startInterval> | null = null
  if (isSessionActivityTrackingActive()) {
    keepalive = startInterval(() => {
      sendSessionActivitySignal()
      context.setSDKStatus?.('compacting')
    }, KEEPALIVE_INTERVAL_MS)
    keepalive.unref?.()
  }
  try {
    if (!directOnly && shouldRideCacheSharingFork(context.options.engineModel, context.options.thinkingConfig)) {
      const forked = await summarizeViaCacheSharingFork(messages, cacheSafeParams, promptMessage, context)
      if (forked !== null) return forked
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
    }
    return await summarizeDirect(messages, cacheSafeParams, promptMessage, context)
  } finally {
    if (keepalive !== null) stopInterval(keepalive)
  }
}
