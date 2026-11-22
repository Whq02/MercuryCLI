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
import { notBuilt } from '../../../../pi/holes.js'

export function settleAttemptLedger(ctx: QueryCtx, call: CallState): void {
  return notBuilt('src/services/providers/anthropic/streamCore/settleCall.ts:16')
}

export function closeSucceededRequest(ctx: QueryCtx, call: CallState): void {
  return notBuilt('src/services/providers/anthropic/streamCore/settleCall.ts:40')
}
