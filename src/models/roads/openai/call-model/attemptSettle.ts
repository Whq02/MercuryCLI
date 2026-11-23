import { settleTranscriptMessage } from '../../../../sessions/transcripts/writer.js'
import type {
  AssistantMessage,
} from '../../../../engine/message-shapes/message.js'
import { EMPTY_USAGE } from '../../../../engine/request-parts/emptyUsage.js'
import {
  checkResponseForCacheBreak,
} from '../../../../engine/requests/promptCacheBreakDetection.js'
import { addToTotalSessionCost } from '../../../usage/sessionCost.js'
import { calculateUSDCost } from '../../../usage/modelCost.js'
import { estimateFaultedRequestUsage } from '../../faultUsageEstimate.js'
import type {
  OpenaiCompletedToolCall,
  OpenaiFault,
  OpenaiFinishReason,
  OpenaiInputItem,
  OpenaiUsage,
} from '../openaiWire.js'
import type { RefusedToolCall } from '../../../../engine/message-shapes/message.js'
import type { StreamEndV1 } from '../../streamIdleBudget.js'
import type { OpenaiSettledFinish } from './attemptEvents.js'
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

const FINISH_TO_STOP: Record<OpenaiFinishReason, 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'> = {
  completed: 'end_turn',
  tool_calls: 'tool_use',
  max_output_tokens: 'max_tokens',
  content_filter: 'refusal',
  'other-incomplete': 'end_turn',
}

type AttemptFacts = {
  usageSeen: OpenaiUsage | undefined
  responseId: string | undefined
  refusalStreamed: boolean
  finish: OpenaiSettledFinish | undefined
  fault: OpenaiFault | undefined
  settledOnFault: OpenaiInputItem[]
  accepted: Array<{ call: OpenaiCompletedToolCall; input: Record<string, unknown> }>
  refused: RefusedToolCall[]
  answered: Array<{ call: OpenaiCompletedToolCall; refusal: RefusedToolCall }>
}

export function settleAttemptUsage(
  ctx: OpenaiAttemptCtx,
  minted: AssistantMessage[],
  facts: AttemptFacts,
  requestStartedAtMs: number,
  typedEnd: StreamEndV1 | null,
) {
  const { request, options, modelId } = ctx
  const { usageSeen, responseId, refusalStreamed, finish, fault, settledOnFault, accepted, refused, answered } = facts
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
      calculateUSDCost(modelId, finalUsage),
      finalUsage,
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
