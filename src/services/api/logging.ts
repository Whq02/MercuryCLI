import { addToTotalDurationState } from '../../bootstrap/state.js'
import type { NonNullableUsage } from './emptyUsage.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { EMPTY_USAGE } from './emptyUsage.js'


export { EMPTY_USAGE }
export type { NonNullableUsage }


export type LogAPIErrorParams = {
  error: unknown
  clientRequestId?: string | null
}

export function logAPIError(params: LogAPIErrorParams): void {
  const { error } = params

  const details = extractConnectionErrorDetails(error)
  if (details !== null) {
    logForDebugging(
      `API connection error: ${details.code}${details.isSSLError ? ' (SSL error)' : ''}: ${details.message}`,
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

  logError(error)
}

export function logAPIDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  const now = Date.now()
  addToTotalDurationState(now - startIncludingRetries, now - start)
}

export function logAPISuccessAndDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  logAPIDuration({ start, startIncludingRetries })
  consumeInvokingRequestId()
}
