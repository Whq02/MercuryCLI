import { addToTotalDurationState } from '../../bootstrap/state.js'
import type { NonNullableUsage } from '../../utils/api/emptyUsage.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { EMPTY_USAGE } from '../../utils/api/emptyUsage.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export { EMPTY_USAGE }
export type { NonNullableUsage }


type LogAPIErrorParams = Unbuilt

export function logAPIError(params: LogAPIErrorParams): void {
  return notBuilt('src/services/api/logging.ts:19')
}

export function logAPIDuration(arg0: {
  start: number
  startIncludingRetries: number
}): void {
  return notBuilt('src/services/api/logging.ts:42')
}

export function logAPISuccessAndDuration(arg0: {
  start: number
  startIncludingRetries: number
}): void {
  return notBuilt('src/services/api/logging.ts:53')
}
