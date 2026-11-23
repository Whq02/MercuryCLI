import { addToTotalDurationState } from '../../bootstrap/state.js'
import type { NonNullableUsage } from '../../utils/api/emptyUsage.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { EMPTY_USAGE } from '../../utils/api/emptyUsage.js'


export { EMPTY_USAGE }
export type { NonNullableUsage }


type LogAPIErrorParams = {
  error: unknown
  clientRequestId?: string | null
}

export function logAPIError(params: LogAPIErrorParams): void {
  const connectionDetails = extractConnectionErrorDetails(params.error)
  if (connectionDetails !== null) {
    const sslSuffix = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `API connection error: ${connectionDetails.code}${sslSuffix}: ${connectionDetails.message}`,
      { level: 'error' },
    )
  }
  consumeInvokingRequestId()
  if (params.clientRequestId) {
    logForDebugging(
      `client request id ${params.clientRequestId} — give this to the API crew to look up the request in server logs`,
      { level: 'error' },
    )
  }
  logError(params.error)
}

export function logAPIDuration(arg0: {
  start: number
  startIncludingRetries: number
}): void {
  const now = Date.now()
  addToTotalDurationState(now - arg0.startIncludingRetries, now - arg0.start)
}

export function logAPISuccessAndDuration(arg0: {
  start: number
  startIncludingRetries: number
}): void {
  logAPIDuration(arg0)
  consumeInvokingRequestId()
}
