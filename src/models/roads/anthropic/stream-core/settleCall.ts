import { setLastMainRequestId } from 'src/boot/process-state/processState.js'
import { addToTotalSessionCost } from 'src/models/usage/sessionCost.js'
import { getCrewmateContext } from 'src/crew/agents/agentContext.js'
import { calculateUSDCost } from 'src/models/usage/modelCost.js'
import { stopSessionActivity } from '../../../../engine/requests/sessionActivity.js'
import { clearModelRefusal } from '../modelRefusal.js'
import {
  EMPTY_USAGE,
  logAPIDuration,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from '../../../../engine/requests/apiCallLogging.js'
import { updateUsage } from '../cacheAndUsage.js'
import type { CallState, CallCtx } from './callState.js'

export function settleAttemptLedger(ctx: CallCtx, call: CallState): void {
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

export function closeSucceededRequest(ctx: CallCtx, call: CallState): void {
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
    !getCrewmateContext() &&
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
