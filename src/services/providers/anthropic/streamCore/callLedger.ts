import { APIError } from '../../../../utils/api/sdkErrors.js'
import type {
  ContentBlock as BetaContentBlock,
  ApiMessage as BetaMessage,
} from '../../../../types/wire.js'
import { randomUUID } from 'crypto'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { logForDebugging } from 'src/utils/debug.js'
import { calculateUSDCost } from 'src/services/usage/modelCost.js'
import { roughTokenCountEstimation } from 'src/services/tokenEstimation.js'
import type { Tools } from '../../../../Tool.js'
import type { ConnectorTextBlock } from '../../../../types/connectorText.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { normalizeContentFromAPI } from '../../../messages.js'
import {
  getCanonicalName,
  normalizeModelStringForAPI,
} from '../../../../utils/model/model.js'
import { extractQuotaStatusFromError } from '../../../anthropicLimits.js'
import {
  logAPIError,
  type NonNullableUsage,
} from '../../../api/logging.js'
import { CannotRetryError } from '../../../api/withRetry.js'
import { cleanupStream } from '../cacheAndUsage.js'
import type { Options } from '../streamCore.js'
import type { CallState, SignInRefusal } from './state.js'
import { passedOver } from '../../../../utils/passedOver.js'

export function createCallLedger(
  call: CallState,
  tools: Tools,
  options: Options,
  resolvedModel: string,
  newMessages: AssistantMessage[],
  contentBlocks: (BetaContentBlock | ConnectorTextBlock)[],
  stoppedBlockIndices: Set<number>,
  observeSignInResponse: SignInRefusal['observeSignInResponse'],
) {
  function releaseStreamResources(): void {
    const held = { stream: call.stream, response: call.streamResponse }
    call.stream = undefined
    call.streamResponse = undefined
    cleanupStream(held.stream)
    held.response?.body?.cancel().catch(passedOver)
  }

  const requestedWire = normalizeModelStringForAPI(options.model)
  const noteServedModel = (model: string | undefined): void => {
    if (!model || model === call.servedModel) return
    if (getCanonicalName(model) === getCanonicalName(requestedWire)) return
    call.servedModel = model
    logForDebugging(`served by ${model} (requested ${requestedWire})`)
  }
  const pricingModel = (): string => call.servedModel ?? resolvedModel

  const mintAssistantMessage = (
    base: BetaMessage,
    blocks: BetaContentBlock[],
  ): AssistantMessage => ({
    message: {
      ...base,
      ...(call.servedModel && { model: call.servedModel }),
      content: normalizeContentFromAPI(blocks, tools),
    },
    requestId: call.streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    effort: call.effortOnWire,
    ...(call.sentThinkingPrefix !== undefined ? { thinkingPrefix: call.sentThinkingPrefix } : {}),
  })

  function* yieldAbortedPartialText(): Generator<AssistantMessage> {
    if (!call.partialMessage) return
    const inFlight = contentBlocks.filter(
      (b, i) =>
        b !== undefined &&
        !stoppedBlockIndices.has(i) &&
        b.type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string' &&
        (b as { text: string }).text.length > 0,
    )
    if (inFlight.length === 0) return
    const m = mintAssistantMessage(
      call.partialMessage,
      inFlight as BetaContentBlock[],
    )
    newMessages.push(m)
    yield m
  }

  const settleUnpricedAttempt = (): void => {
    if (call.ledgerSettled || call.partialMessage === undefined) return
    call.ledgerSettled = true
    let streamedText = ''
    for (const block of contentBlocks) {
      if (block === undefined) continue
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') streamedText += text
      const thinking = (block as { thinking?: unknown }).thinking
      if (typeof thinking === 'string') streamedText += thinking
    }
    const settled: NonNullableUsage = {
      ...call.usage,
      output_tokens: Math.max(
        call.usage.output_tokens,
        roughTokenCountEstimation(streamedText),
      ),
    }
    addToTotalSessionCost(
      calculateUSDCost(pricingModel(), settled),
      settled,
      pricingModel(),
    )
  }

  const logRequestFailure = (
    thrown: unknown,
  ): { error: unknown; errorModel: string } => {
    let error = thrown
    let errorModel = options.model
    if (thrown instanceof CannotRetryError) {
      error = thrown.originalError
      errorModel = thrown.retryContext.model
    }

    if (error instanceof APIError) {
      extractQuotaStatusFromError(error)
      observeSignInResponse(call.signInRequest, error.status)
    }

    logAPIError({ error, clientRequestId: call.clientRequestId })

    return { error, errorModel }
  }

  return { releaseStreamResources, noteServedModel, pricingModel, mintAssistantMessage, yieldAbortedPartialText, settleUnpricedAttempt, logRequestFailure }
}
