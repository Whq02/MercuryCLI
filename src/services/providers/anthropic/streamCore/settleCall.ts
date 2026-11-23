import { setLastMainRequestId } from 'src/bootstrap/state.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { calculateUSDCost } from 'src/services/usage/modelCost.js'
import { stopSessionActivity } from '../../../../utils/sessionActivity.js'
import { clearModelRefusal } from '../modelRefusal.js'
import {
  EMPTY_USAGE,
  logAPIDuration,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from '../../../api/logging.js'
import { updateUsage } from '../cacheAndUsage.js'
import type { CallState, QueryCtx } from './state.js'

export function settleAttemptLedger(ctx: QueryCtx, call: CallState): void {
  if (!call.ledgerSettled) {
    if (call.didFallBackToNonStreaming && call.fallbackMessage) {
      call.ledgerSettled = true
      const usage: NonNullableUsage = updateUsage(
        EMPTY_USAGE,
        call.fallbackMessage.message.usage,
      )
      call.usage = usage
      const model = ctx.pricingModel()
      addToTotalSessionCost(calculateUSDCost(model, usage), usage, model)
    } else {
      ctx.settleUnpricedAttempt()
    }
  }
  if (!call.settledNormally && call.start > 0) {
    logAPIDuration({
      start: call.start,
      startIncludingRetries: ctx.startIncludingRetries,
    })
  }
  stopSessionActivity('api_call')
}

export function closeSucceededRequest(ctx: QueryCtx, call: CallState): void {
  ctx.observeSignInResponse(call.signInRequest, 200)
  const refusalRequest = ctx.modelRefusalRequest.current
  if (refusalRequest) {
    clearModelRefusal(
      refusalRequest.id,
      refusalRequest.door,
      refusalRequest.home,
      refusalRequest.presented,
    )
  }
  const requestId = call.fallbackMessage?.requestId ?? call.streamRequestId ?? undefined
  if (requestId && !getAgentContext() && !ctx.options.agentId) {
    setLastMainRequestId(requestId)
  }
  logAPISuccessAndDuration({
    start: call.start,
    startIncludingRetries: ctx.startIncludingRetries,
  })
  ctx.releaseStreamResources()
}
