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
  const { startIncludingRetries, releaseStreamResources, pricingModel, settleUnpricedAttempt } = ctx
  stopSessionActivity('api_call')
  releaseStreamResources()

  settleUnpricedAttempt()
  if (!call.settledNormally) logAPIDuration({ start: call.start, startIncludingRetries })

  if (call.fallbackMessage) {
    const fallbackUsage = call.fallbackMessage.message.usage
    call.usage = updateUsage(EMPTY_USAGE, fallbackUsage)
    call.stopReason = call.fallbackMessage.message.stop_reason
    const fallbackCost = calculateUSDCost(
      pricingModel(),
      fallbackUsage as NonNullableUsage,
    )
    addToTotalSessionCost(
      fallbackCost,
      fallbackUsage as NonNullableUsage,
      pricingModel(),
    )
  }
}

export function closeSucceededRequest(ctx: QueryCtx, call: CallState): void {
  const { options, modelRefusalRequest, observeSignInResponse, startIncludingRetries, releaseStreamResources } = ctx
  if (
    call.streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(call.streamRequestId)
  }

  observeSignInResponse(call.signInRequest, 200)
  const successfulRequest = modelRefusalRequest.current
  if (successfulRequest !== undefined) {
    clearModelRefusal(successfulRequest.id, successfulRequest.door, successfulRequest.home, successfulRequest.presented)
  }

  void options.getToolPermissionContext().then(() => {
    logAPISuccessAndDuration({
      start: call.start,
      startIncludingRetries,
    })
  })

  releaseStreamResources()
}
