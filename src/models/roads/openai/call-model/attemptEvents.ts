import { processOwnerForLane } from '../../../../engine/run-owner/resolveOwner.js'
import { streamOpenaiResponsesRoad } from '../openaiClient.js'
import { openaiSocketRoadChosen } from '../openaiSocketTransport.js'
import { coldPrefixOf, estimateRequestTokens, silentAfterHeadersWindowMs, streamIdleTimeoutMsForRoute } from '../../streamIdleBudget.js'
import { getPublicModelDisplayName } from '../../../catalogue/engineModel.js'
import type {
  OpenaiStreamEvent,
} from '../openaiWire.js'
import type { OpenaiAttemptCtx } from './attempt.js'

export type OpenaiSettledFinish = Pick<Extract<OpenaiStreamEvent, { type: 'finish' }>, 'reason' | 'toolCalls' | 'orderedItems' | 'refusalText' | 'unknownItemTypes' | 'webSearchCalls' | 'citations' | 'incompleteDetail'>

export function settledFinishOf(event: Extract<OpenaiStreamEvent, { type: 'finish' }>): OpenaiSettledFinish {
  return {
    reason: event.reason,
    toolCalls: event.toolCalls,
    orderedItems: event.orderedItems,
    refusalText: event.refusalText,
    unknownItemTypes: event.unknownItemTypes,
    webSearchCalls: event.webSearchCalls ?? [],
    citations: event.citations ?? [],
    ...(event.incompleteDetail !== undefined
      ? { incompleteDetail: event.incompleteDetail }
      : {}),
  }
}

export function openAttemptEvents(ctx: OpenaiAttemptCtx): AsyncIterable<OpenaiStreamEvent> {
  const { request, auth, signal, options, modelId } = ctx
  const idleTimeoutMs = streamIdleTimeoutMsForRoute('openai')
  const cold = coldPrefixOf(ctx.messages, modelId)
  const promptTokens = estimateRequestTokens(request)
  const events =
    ctx._eventsForTesting ??
    streamOpenaiResponsesRoad({
      baseUrl: auth.baseUrl,
      headers: auth.headers,
      request,
      signal,
      ...(auth.account.kind === 'api-key' && openaiSocketRoadChosen()
        ? { socket: { owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) } }
        : {}),
      idleTimeoutMs,
      silentAfterHeadersMs: silentAfterHeadersWindowMs({ route: 'openai', cold, promptTokens, idleMs: idleTimeoutMs }),
      ...(options.onStreamActivity ? { onStreamActivity: options.onStreamActivity } : {}),
      firstByte: {
        cold,
        promptTokens,
        model: getPublicModelDisplayName(modelId) ?? modelId,
        ...(ctx.attempt !== undefined ? { attempt: ctx.attempt } : {}),
        ...(options.onWait ? { onWait: options.onWait } : {}),
      },
    })
  return events
}
