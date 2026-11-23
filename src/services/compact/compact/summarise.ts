import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import { continuationOfSentRequest, lastSentRequestFor, runForkedAgent, type CacheSafeParams } from '../../agents/forkedAgent.js'
import { appendSystemContext } from '../../messages/api.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { logError } from '../../../utils/log.js'
import { isRecord } from '../../../utils/isRecord.js'
import { findLastCompactBoundaryIndex, getAssistantMessageText } from '../../messages.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../../utils/sessionActivity.js'
import { tokenCountWithEstimation } from '../../context/tokens.js'
import { isToolSearchEnabled } from '../../messages/toolSearch.js'
import { LOCAL_WINDOW_REMEDY, localFitRefusalFacts } from '../../providers/local/localCatalogue.js'
import { routedCallModel, settleAssistantTurn } from '../../providers/callModelRouter.js'
import { coldPrefixOf } from '../../providers/streamIdleBudget.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { rosterOwnerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { FileReadTool } from '../../../tools/FileReadTool/FileReadTool.js'
import { ToolSearchTool } from '../../../tools/ToolSearchTool/ToolSearchTool.js'
import { projectRewoundWindows } from '../checkpointRewind.js'
import { ERROR_MESSAGE_INCOMPLETE_RESPONSE, KEEPALIVE_INTERVAL_MS } from './limits.js'
import { isOverflowAnswer, malformedHistoryRefusalOf, foldRemedyIsHeadless, foldWindowRefusalText, CompactionRefusedForHistoryError } from './refusals.js'
import { ERROR_MESSAGE_FOLD_TIMEOUT, armFoldBound, foldCutWords, shouldRideCacheSharingFork, recordFoldRoad } from './foldBound.js'
import { createCompactCanUseTool } from './input.js'
import { summaryAnswerFault, summaryRefusedByModel } from './summaryCheck.js'
import { startInterval, stopInterval } from '../../../utils/timers.js'

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
  const handOverAtBound = (): null => {
    const elapsed = Date.now() - startedAt
    logForDebugging(`compact: fork lane cut for ${foldCutWords(bound)} after ${elapsed} ms — handing over to direct lane`, { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsed} ms`)
    return null
  }
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
      if (isRecord(status) && status.streamActivity !== undefined) bound.touch()
      context.setSDKStatus?.(status)
    }
    const result = await runForkedAgent({
      promptMessages: [promptMessage],
      cacheSafeParams: {
        ...cacheSafeParams,
        toolUseContext: context,
        forkContextMessages: messages,
      },
      canUseTool: createCompactCanUseTool(),
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
    if (bound.hitDeadline()) return handOverAtBound()
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
        throw new CompactionRefusedForHistoryError(malformed, {
          nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
        })
      }
    }
    logForDebugging('compact: fork lane did not produce a usable summary — handing over to direct lane', { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', 'no usable summary')
    return null
  } catch (error) {
    if (error instanceof CompactionRefusedForHistoryError) throw error
    if (bound.hitDeadline()) return handOverAtBound()
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    logError(error)
    recordFoldRoad(model, 'fork', startedAt, 'handover', error instanceof Error ? error.message : String(error))
    return null
  } finally {
    bound.dispose()
  }
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
          ? [FileReadTool, ToolSearchTool]
          : [FileReadTool]

    const boundaryIndex = findLastCompactBoundaryIndex(messages)
    const afterBoundary = boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages
    const projected = projectRewoundWindows(afterBoundary)
    const ownerKey = String(rosterOwnerFromToolUseContext(context))
    const continuation = continuationOfSentRequest(lastSentRequestFor(ownerKey), projected)
    const requestMessages: Message[] =
      continuation !== null
        ? [...continuation.sent, ...continuation.tail, promptMessage]
        : [...projected, promptMessage]

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

    const assistantMessages: AssistantMessage[] = []
    try {
      for await (const item of stream) {
        bound.content()
        if (item.type === 'stream_event') {
          if (item.event.type === 'content_block_start' && item.event.content_block.type === 'text') {
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
      if (bound.hitDeadline()) {
        logForDebugging(`compact: direct lane cut for ${foldCutWords(bound)} after ${Date.now() - startedAt} ms — nothing folded`, { level: 'warn' })
        recordFoldRoad(model, 'direct', startedAt, 'timeout', foldCutWords(bound))
        throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
      }
      if (bound.signal.aborted) {
        recordFoldRoad(model, 'direct', startedAt, 'aborted')
        throw new APIUserAbortError()
      }
      throw error
    }

    if (bound.hitDeadline()) {
      logForDebugging(`compact: direct lane cut for ${foldCutWords(bound)} after ${Date.now() - startedAt} ms — nothing folded`, { level: 'warn' })
      recordFoldRoad(model, 'direct', startedAt, 'timeout', foldCutWords(bound))
      throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
    }
    if (bound.signal.aborted) {
      recordFoldRoad(model, 'direct', startedAt, 'aborted')
      throw new APIUserAbortError()
    }

    const captured = assistantMessages.at(-1)
    if (captured === undefined) {
      logError(new Error('compact: direct summarization returned no assistant message'))
      recordFoldRoad(model, 'direct', startedAt, 'incomplete')
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    }
    if (captured.isApiErrorMessage !== true) {
      recordFoldRoad(model, 'direct', startedAt, 'summary')
      return settleAssistantTurn(assistantMessages, false)
    }
    if (isOverflowAnswer(captured)) {
      recordFoldRoad(model, 'direct', startedAt, 'overflow')
      return captured
    }
    if (summaryRefusedByModel(captured)) {
      recordFoldRoad(model, 'direct', startedAt, 'refused')
      return captured
    }
    if (summaryAnswerFault(captured) !== null) {
      recordFoldRoad(model, 'direct', startedAt, 'incomplete')
      return captured
    }
    const malformed = malformedHistoryRefusalOf(captured)
    if (malformed !== null) {
      recordFoldRoad(model, 'direct', startedAt, 'refused')
      throw new CompactionRefusedForHistoryError(malformed, {
        nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
      })
    }
    const text = getAssistantMessageText(captured) ?? ''
    const fitFacts = localFitRefusalFacts(text)
    if (fitFacts !== null) {
      recordFoldRoad(model, 'direct', startedAt, 'refused')
      throw new Error(
        foldWindowRefusalText({
          window: fitFacts.window,
          sourceWords: fitFacts.sourceWords,
          estTokens: fitFacts.estTokens,
          remedy: LOCAL_WINDOW_REMEDY,
        }),
      )
    }
    recordFoldRoad(model, 'direct', startedAt, 'refused')
    throw new Error(text !== '' ? text : ERROR_MESSAGE_INCOMPLETE_RESPONSE)
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
