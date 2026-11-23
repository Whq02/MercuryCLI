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
  stopSessionActivity('api_call')
  ctx.releaseStreamResources()
  ctx.settleUnpricedAttempt()
  if (!call.settledNormally) {
    logAPIDuration({
      start: call.start,
      startIncludingRetries: ctx.startIncludingRetries,
    })
  }
}

export function closeSucceededRequest(ctx: QueryCtx, call: CallState): void {
  if (call.fallbackMessage) {
    const fallbackUsage: NonNullableUsage = updateUsage(
      EMPTY_USAGE,
      call.fallbackMessage.message.usage,
    )
    call.usage = fallbackUsage
    call.stopReason = call.fallbackMessage.message.stop_reason
    const model = ctx.pricingModel()
    addToTotalSessionCost(calculateUSDCost(model, fallbackUsage), fallbackUsage, model)
  }
  if (
    call.streamRequestId &&
    !getAgentContext() &&
    (ctx.options.querySource.startsWith('main_thread') ||
      ctx.options.querySource === 'sdk')
  ) {
    setLastMainRequestId(call.streamRequestId)
  }
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
  void ctx.options.getToolPermissionContext().then(
    () => {
      logAPISuccessAndDuration({
        start: call.start,
        startIncludingRetries: ctx.startIncludingRetries,
      })
    },
    () => {
      logAPISuccessAndDuration({
        start: call.start,
        startIncludingRetries: ctx.startIncludingRetries,
      })
    },
  )
  ctx.releaseStreamResources()
}
