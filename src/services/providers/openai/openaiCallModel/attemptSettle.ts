import { settleTranscriptMessage } from '../../../../utils/sessionStorage/writer.js'
import type {
  ContentBlock,
} from '../../../../types/wire.js'
import type {
  AssistantMessage,
} from '../../../../types/message.js'
import { EMPTY_USAGE } from '../../../api/emptyUsage.js'
import {
  checkResponseForCacheBreak,
} from '../../../api/promptCacheBreakDetection.js'
import { addToTotalSessionCost } from '../../../../cost-tracker.js'
import { calculateUSDCost } from '../../../../utils/modelCost.js'
import { estimateFaultedRequestUsage } from '../../faultUsageEstimate.js'
import { emptyReplyChatText, emptyReplyNote, markEmptyReply, type EmptyReplyKind } from '../../emptyReply.js'
import {
  loadedToolNamesOf,
} from '../responsesBridge.js'
import { logForDebugging } from '../../../../utils/debug.js'
import type {
  OpenaiCompletedToolCall,
  OpenaiFinishReason,
  OpenaiInputItem,
  OpenaiUsage,
} from '../openaiWire.js'
import type { RefusedToolCall } from '../../../../types/message.js'
import { gateToolCalls, refusalAnswersAsToolResult, refusedCallInput, toolCallRefusalDiagnostic, toolCallRefusalNote } from '../../toolCallGate.js'
import type { StreamEndV1 } from '../../streamIdleBudget.js'
import type { AttemptBlocks } from './attemptBlocks.js'
import type { AttemptRead, OpenaiSettledFinish } from './attemptEvents.js'
import type { OpenaiAttemptCtx } from './attempt.js'

export function mapOpenaiUsageToAnthropic(usage: OpenaiUsage | undefined, webSearchRequests = 0): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  const written = usage?.cacheWriteInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached - written),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    server_tool_use: { ...EMPTY_USAGE.server_tool_use, web_search_requests: webSearchRequests },
  }
}

export function buildProviderUsageReceipt(usage: OpenaiUsage): NonNullable<
  NonNullable<AssistantMessage['apexProviderTurn']>['providerUsage']
> {
  const total = usage.inputTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  return {
    inputTokensTotal: total,
    cachedInputTokens: cached,
    outputTokens: usage.outputTokens ?? 0,
    ...(typeof usage.cacheWriteInputTokens === 'number'
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
    ...(typeof usage.reasoningOutputTokens === 'number'
      ? { reasoningOutputTokens: usage.reasoningOutputTokens }
      : {}),
    ...(cached > total ? { anomaly: 'cached-exceeds-total' as const } : {}),
  }
}

export function replayableItems(
  orderedItems: readonly OpenaiInputItem[],
  refused: readonly (Pick<RefusedToolCall, 'id'> & { code?: RefusedToolCall['code'] })[],
): OpenaiInputItem[] {
  const refusedIds = new Set(refused.filter(r => r.code !== 'duplicate-id').map(r => r.id))
  const seenCallIds = new Set<string>()
  const kept: OpenaiInputItem[] = []
  let reasoning: OpenaiInputItem[] = []
  for (const item of orderedItems) {
    if (item.type === 'reasoning') {
      reasoning.push(item)
      continue
    }
    if (item.type === 'function_call') {
      if (refusedIds.has(item.call_id) || seenCallIds.has(item.call_id)) {
        reasoning = []
        continue
      }
      seenCallIds.add(item.call_id)
    }
    kept.push(...reasoning, item)
    reasoning = []
  }
  return kept
}

export const FINISH_TO_STOP: Record<OpenaiFinishReason, 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'> = {
  completed: 'end_turn',
  tool_calls: 'tool_use',
  max_output_tokens: 'max_tokens',
  content_filter: 'refusal',
  'other-incomplete': 'end_turn',
}

export function* settleAttemptToolCalls(ctx: OpenaiAttemptCtx, w: AttemptBlocks, finish: OpenaiSettledFinish | undefined) {
  const { tools } = ctx
  const { livePaintComplete, minted, mintBlock, emitSettledBlock, emitNoteBlock } = w
  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: OpenaiCompletedToolCall; input: Record<string, unknown> }> = []
  const refused: RefusedToolCall[] = []
  const answered: Array<{ call: OpenaiCompletedToolCall; refusal: RefusedToolCall }> = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.callId,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted, straightenQuotes: true },
  )
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
    else if (finish?.reason !== 'max_output_tokens' && refusalAnswersAsToolResult(verdict.refusal)) answered.push({ call, refusal: verdict.refusal })
    else refused.push(verdict.refusal)
  })
  for (const [index, call] of completed.entries()) {
    const verdict = verdicts[index]!
    const refusal = verdict.ok ? undefined : answered.find(entry => entry.call === call)?.refusal
    if (!verdict.ok && refusal === undefined) continue
    const input = verdict.ok ? verdict.input : refusedCallInput(refusal!)
    const decorate = refusal === undefined ? undefined : (message: AssistantMessage): void => {
      message.refusedToolCalls = [refusal]
    }
    if (refusal !== undefined) logForDebugging(`[openai] ${toolCallRefusalDiagnostic(refusal)}`, { level: 'warn' })
    if (livePaintComplete.has(call.callId)) {
      const m = mintBlock({
        type: 'tool_use',
        id: call.callId,
        name: call.name,
        input,
      })
      decorate?.(m)
      minted.push(m)
      yield m
      continue
    }
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.callId, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: verdict.ok ? call.argumentsRaw : JSON.stringify(input) }],
      { type: 'tool_use', id: call.callId, name: call.name, input: {} },
      decorate,
    )
  }
  for (const refusal of refused) {
    yield* emitNoteBlock(toolCallRefusalNote('openai', refusal), message => {
      message.refusedToolCalls = [refusal]
    })
  }
  return { accepted, refused, answered }
}

export function* emitFinishNotes(w: AttemptBlocks, read: AttemptRead) {
  const { minted, emitSettledBlock, emitNoteBlock } = w
  const { finish, refusalStreamed, usageSeen } = read
  if (finish && finish.webSearchCalls.length > 0) {
    for (const call of finish.webSearchCalls) {
      const block: ContentBlock = { type: 'server_tool_use', id: call.id, name: 'web_search', input: call.query !== undefined ? { query: call.query } : {} }
      yield* emitSettledBlock(block, [], block)
    }
    const lastCall = finish.webSearchCalls[finish.webSearchCalls.length - 1]!
    const resultBlock: ContentBlock = {
      type: 'web_search_tool_result',
      tool_use_id: lastCall.id,
      content: finish.citations.map(citation => ({ type: 'web_search_result', title: citation.title, url: citation.url })),
    }
    yield* emitSettledBlock(resultBlock, [], resultBlock)
  }
  if (finish?.refusalText && !refusalStreamed) yield* emitNoteBlock(finish.refusalText)
  if (finish?.reason === 'content_filter' && !refusalStreamed && !finish.refusalText) {
    yield* emitNoteBlock(
      '[openai] the provider ended this response under its content filter — the turn is incomplete by provider policy.',
    )
  }
  if (finish?.reason === 'other-incomplete') {
    yield* emitNoteBlock(
      `[openai] the provider ended this response INCOMPLETE (${finish.incompleteDetail ?? 'no reason stated'}) — the turn was cut short by the provider, not finished; continue or retry as needed.`,
    )
  }
  if (finish && finish.unknownItemTypes.length > 0) {
    yield* emitNoteBlock(
      `[openai] the provider returned output item types Mercury does not decode yet (${finish.unknownItemTypes.join(', ')}); recorded here.`,
    )
  }
  const loadedTools = finish ? loadedToolNamesOf(finish.orderedItems) : []
  if (loadedTools.length > 0) {
    logForDebugging(`[openai] tool search loaded ${loadedTools.length} deferred tool(s) server-side (${loadedTools.join(', ')}); the tools array is unchanged and the loaded definitions replay at the end of the input`)
  }
  if (minted.length === 0) {
    const emptyKind: EmptyReplyKind =
      finish?.reason === 'max_output_tokens'
        ? 'cap'
        : finish?.reason === 'completed' && finish.orderedItems.length > 0
          ? 'silence'
          : 'empty'
    const emptyNote = emptyReplyNote('openai', emptyKind, usageSeen?.reasoningOutputTokens)
    if (emptyKind === 'silence') logForDebugging(emptyNote)
    yield* emitNoteBlock(emptyReplyChatText(emptyKind, emptyNote), message => markEmptyReply(message, emptyKind, emptyNote))
  }
}

export function settleAttemptUsage(
  ctx: OpenaiAttemptCtx,
  minted: AssistantMessage[],
  read: AttemptRead,
  settled: GeneratorReturn<ReturnType<typeof settleAttemptToolCalls>>,
  requestStartedAtMs: number,
  typedEnd: StreamEndV1 | null,
) {
  const { request, options, modelId } = ctx
  const { usageSeen, responseId, refusalStreamed, finish, fault, settledOnFault } = read
  const { accepted, refused, answered } = settled
  const mappedFinish = refusalStreamed || finish?.refusalText ? 'refusal' : FINISH_TO_STOP[finish?.reason ?? 'completed'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 || answered.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = Object.assign(mapOpenaiUsageToAnthropic(usageSeen, finish?.webSearchCalls.length ?? 0), { request_started_at_ms: requestStartedAtMs })
  if (!usageSeen && fault !== undefined) {
    const estimated = Object.assign(estimateFaultedRequestUsage({ lane: 'openai', model: modelId, request, minted, faultCode: fault.code }), { request_started_at_ms: requestStartedAtMs })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    addToTotalSessionCost(
      calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
    )
  }
  if (usageSeen) {
    void checkResponseForCacheBreak(
      options.querySource,
      finalUsage.cache_read_input_tokens,
      finalUsage.cache_creation_input_tokens ?? 0,
      ctx.messages,
      options.agentId,
      responseId ?? null,
    )
  }
  const lastMessage = minted.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    if (typedEnd !== null) lastMessage.streamEnd = typedEnd
    if (ctx.effortAdjusted !== undefined) lastMessage.effortAdjusted = ctx.effortAdjusted
    const mintedCallIds = new Set([...accepted, ...answered].map(({ call }) => call.callId))
    const settledItems = finish?.orderedItems ?? (typedEnd !== null ? settledOnFault : [])
    const replayItems = replayableItems(
      settledItems.filter(item => item.type !== 'function_call' || mintedCallIds.has(item.call_id)),
      refused,
    )
    if (replayItems.length > 0) {
      lastMessage.apexProviderTurn = {
        provider: 'openai',
        items: replayItems as unknown[],
        ...(responseId ? { responseId } : {}),
        contractDigest: ctx.contractDigest,
        ...(usageSeen ? { providerUsage: buildProviderUsageReceipt(usageSeen) } : {}),
      }
    }
    void settleTranscriptMessage(lastMessage)
  }
  return { stopReason, finalUsage } as const
}

type GeneratorReturn<G> = G extends Generator<unknown, infer R, unknown> ? R : never
