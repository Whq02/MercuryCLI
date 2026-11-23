import { ProtocolError, SdkError, SdkErrorCode } from '../../../utils/mcp/sdk.js'
import { deepestErrorDetail, isStaleSocketCode } from '../../../utils/api/transportEvidence.js'
import { errorMessage, TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../utils/errors.js'
import { isRecord } from '../../../utils/isRecord.js'

export class McpAuthError extends Error {
  constructor(
    public readonly serverName: string,
    message: string,
  ) {
    super(message)
    this.name = 'McpAuthError'
  }
}

export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    public readonly mcpMeta?: Record<string, unknown>,
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

export class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP session for ${serverName} expired`)
    this.name = 'McpSessionExpiredError'
  }
}

export function isMcpSessionExpiredError(error: unknown): boolean {
  const status = isRecord(error) ? error.status : undefined
  const message = errorMessage(error)
  if (status === 404 && (message.includes('"code":-32001') || message.includes('"code": -32001'))) return true
  return false
}

export function isConnectionClosedError(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
}

export function isProbeExitError(error: unknown): boolean {
  return (
    error instanceof SdkError &&
    error.code === SdkErrorCode.EraNegotiationFailed &&
    /closed during the server\/discover probe/.test(error.message)
  )
}

const STALE_SOCKET_MESSAGE_SUBSTRINGS = ['other side closed', 'socket hang up', 'ECONNRESET', 'terminated']
export function isStaleSocketFetchError(error: unknown): boolean {
  if (isStaleSocketCode(deepestErrorDetail(error).code)) return true
  if (!(error instanceof TypeError)) return false
  const message = `${errorMessage(error)} ${errorMessage(error.cause)}`
  return STALE_SOCKET_MESSAGE_SUBSTRINGS.some(substring => message.includes(substring))
}

export const RESPONSE_STREAM_ENDED = 'mercury/response-stream-ended'

export function isResponseStreamEndedError(error: unknown): boolean {
  return error instanceof ProtocolError && isRecord(error.data) && error.data.reason === RESPONSE_STREAM_ENDED
}
