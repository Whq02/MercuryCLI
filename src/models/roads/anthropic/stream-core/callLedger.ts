import { APIError } from '../../../../engine/request-parts/sdkErrors.js'
import type {
  ContentBlock as BetaContentBlock,
  ApiMessage as BetaMessage,
} from '../../../../engine/message-shapes/wire.js'
import { randomUUID } from 'crypto'
import { addToTotalSessionCost } from 'src/models/usage/sessionCost.js'
import { logForDebugging } from 'src/platform/logs/debugLog.js'
import { calculateUSDCost } from 'src/models/usage/modelCost.js'
import { roughTokenCountEstimation } from 'src/models/facts/tokenEstimation.js'
import type { Tools } from '../../../../tools/kit/tool.js'
import type { ConnectorTextBlock } from '../connectorText.js'
import type { AssistantMessage } from '../../../../engine/message-shapes/message.js'
import { normalizeContentFromAPI } from '../../../../engine/messages/messages.js'
import {
  getCanonicalName,
  normalizeModelStringForAPI,
} from '../../../catalogue/engineModel.js'
import { extractQuotaStatusFromError } from '../anthropicLimits.js'
import {
  logAPIError,
  type NonNullableUsage,
} from '../../../../engine/requests/apiCallLogging.js'
import { CannotRetryError } from '../../../../engine/requests/withRetry.js'
import { cleanupStream } from '../cacheAndUsage.js'
import type { Options } from '../streamCore.js'
import type { CallState, SignInRefusal } from './callState.js'
import { passedOver } from '../../../../platform/errors/passedOver.js'

export function createCallLedger(
  call: CallState,
  tools: Tools,
  options: Options,
  resolvedModel: string,
  newMessages: AssistantMessage[],
  contentBlocks: (BetaContentBlock | ConnectorTextBlock)[],
  stoppedBlockIndices: Set<number>,
  observeSignInResponse: SignInRefusal['observeSignInResponse'],
): {
  releaseStreamResources: () => void
  noteServedModel: (model: string | undefined) => void
  pricingModel: () => string
  mintAssistantMessage: (
    baseMessage: BetaMessage,
    content: (BetaContentBlock | ConnectorTextBlock)[],
  ) => AssistantMessage
  yieldAbortedPartialText: () => Generator<AssistantMessage, void>
  settleUnpricedAttempt: () => void
  logRequestFailure: (thrown: unknown) => { error: unknown; errorModel: string }
} {
  const releaseStreamResources = (): void => {
    const stream = call.stream
    const response = call.streamResponse
    call.stream = undefined
    call.streamResponse = undefined
    cleanupStream(stream)
    const body = response?.body
    if (body) {
      try {
        void body.cancel().catch(passedOver)
      } catch (error) {
        passedOver(error)
      }
    }
  }

  const noteServedModel = (model: string | undefined): void => {
    if (!model) return
    if (model === call.servedModel) return
    const requestedWire = normalizeModelStringForAPI(options.model)
    if (getCanonicalName(model) === getCanonicalName(requestedWire)) return
    call.servedModel = model
    logForDebugging(`served by ${model} (requested ${requestedWire})`)
  }

  const pricingModel = (): string => call.servedModel ?? resolvedModel

  const mintAssistantMessage = (
    baseMessage: BetaMessage,
    content: (BetaContentBlock | ConnectorTextBlock)[],
  ): AssistantMessage => ({
    message: {
      ...baseMessage,
      ...(call.servedModel ? { model: call.servedModel } : {}),
      content: normalizeContentFromAPI(content as BetaMessage['content'], tools),
    },
    requestId: call.streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    effort: call.effortOnWire,
    ...(call.sentThinkingPrefix !== undefined ? { thinkingPrefix: call.sentThinkingPrefix } : {}),
  })

  function* yieldAbortedPartialText(): Generator<AssistantMessage, void> {
    if (!call.partialMessage) return
    const unstoppedTextBlocks: BetaContentBlock[] = []
    for (let i = 0; i < contentBlocks.length; i++) {
      if (stoppedBlockIndices.has(i)) continue
      const block = contentBlocks[i]
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        unstoppedTextBlocks.push(block)
      }
    }
    if (unstoppedTextBlocks.length === 0) return
    const partial = mintAssistantMessage(call.partialMessage, unstoppedTextBlocks)
    newMessages.push(partial)
    yield partial
  }

  const settleUnpricedAttempt = (): void => {
    if (call.ledgerSettled || !call.partialMessage) return
    call.ledgerSettled = true
    let generated = ''
    for (let i = 0; i < contentBlocks.length; i++) {
      const block = contentBlocks[i]
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        generated += block.text
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        generated += block.thinking
      } else if (block.type === 'connector_text' && typeof block.text === 'string') {
        generated += block.text
      }
    }
    const estimatedOutput = roughTokenCountEstimation(generated)
    const settledUsage: NonNullableUsage = {
      ...call.usage,
      output_tokens: Math.max(call.usage.output_tokens, estimatedOutput),
    }
    const model = pricingModel()
    addToTotalSessionCost(calculateUSDCost(model, settledUsage), settledUsage, model)
  }

  const logRequestFailure = (thrown: unknown): { error: unknown; errorModel: string } => {
    let error: unknown = thrown
    let errorModel = options.model
    if (thrown instanceof CannotRetryError) {
      error = thrown.originalError
      errorModel = thrown.retryContext.model
    }
    if (error instanceof APIError) {
      extractQuotaStatusFromError(error)
      observeSignInResponse(call.signInRequest, error.status)
    }
    logAPIError({
      error,
      clientRequestId: call.clientRequestId,
    })
    return { error, errorModel }
  }

  return {
    releaseStreamResources,
    noteServedModel,
    pricingModel,
    mintAssistantMessage,
    yieldAbortedPartialText,
    settleUnpricedAttempt,
    logRequestFailure,
  }
}
