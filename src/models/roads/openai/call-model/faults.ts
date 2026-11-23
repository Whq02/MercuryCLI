import type {
  AssistantMessage,
  BusyRefusalV1,
} from '../../../../engine/message-shapes/message.js'
import { classifyOverflowFault, type OverflowSignal } from '../../../../engine/requests/overflowSignal.js'
import { type MediaRefusal } from '../../../../engine/request-parts/mediaRefusal.js'
import {
  createAssistantAPIErrorMessage,
} from '../../../../engine/messages/messages.js'
import type {
  OpenaiFault,
} from '../openaiWire.js'

export const OPENAI_MAX_ATTEMPTS = 2
const OPENAI_RETRY_BACKOFF_MS = 400
export const MODEL_NOT_FOUND_CODE = /(?:^|[_-])model_not_found$/

export function openaiRetryDelayMs(attempt: number): number {
  return OPENAI_RETRY_BACKOFF_MS * attempt
}

export function effortVocabularyRefusalOf(
  fault: Pick<OpenaiFault, 'code' | 'message'> & { wireMessage?: string },
  sentEffort: string | undefined,
): { refused: string; levels: string[] } | undefined {
  if (sentEffort === undefined || fault.code !== 'openai-invalid_value') return undefined
  const text = (fault.wireMessage ?? fault.message).replace(/\s*\(request captured: [^)]+\)\s*$/, '')
  const match = /Invalid value: '([^']+)'\. Supported values are: (.+?)\.?\s*$/.exec(text)
  if (match === null || match[1] !== sentEffort) return undefined
  const levels = [...match[2]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)
  return levels.length > 0 ? { refused: match[1]!, levels } : undefined
}

export function openaiFaultToTypedError(
  fault: Pick<import('../openaiWire.js').OpenaiFault, 'kind' | 'code'> & { status?: number },
): NonNullable<AssistantMessage['error']> {
  if (MODEL_NOT_FOUND_CODE.test(fault.code)) return 'invalid_request'
  if (fault.kind === 'usage-limit') return 'rate_limit'
  if (fault.status !== undefined) {
    if (fault.status === 401 || fault.status === 403) return 'authentication_failed'
    if (fault.status === 402) return 'billing_error'
    if (fault.status === 429) return 'rate_limit'
    if (fault.status === 408 || fault.status >= 500) return 'server_error'
    if (fault.status >= 400) {
      return /invalid_api_key|authentication/.test(fault.code) ? 'authentication_failed' : 'invalid_request'
    }
  }
  if (/http-401|http-403|openai-invalid_api_key|openai-authentication/.test(fault.code)) {
    return 'authentication_failed'
  }
  if (fault.kind === 'api-error' && /http-4|openai-invalid/.test(fault.code)) {
    return 'invalid_request'
  }
  if (
    fault.kind === 'timeout' ||
    fault.kind === 'transport-error' ||
    fault.kind === 'truncated-stream' ||
    fault.kind === 'response-failed' ||
    fault.kind === 'http-error' ||
    fault.kind === 'api-error'
  ) {
    return 'server_error'
  }
  return 'unknown'
}

export function apiErrorMessage(
  content: string,
  error: NonNullable<AssistantMessage['error']> = 'unknown',
  errorDetails?: string,
  overflow?: OverflowSignal | null,
  mediaRefusal?: MediaRefusal | null,
  busyRefusal?: BusyRefusalV1 | null,
): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content,
    error,
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
    ...(mediaRefusal !== undefined ? { mediaRefusal } : {}),
    ...(busyRefusal !== undefined ? { busyRefusal } : {}),
  })
}

export function overflowOf(fault: { status?: number; code: string; message: string; wireMessage?: string }): OverflowSignal | null {
  return classifyOverflowFault({ family: 'openai', status: fault.status, code: fault.code, message: fault.wireMessage ?? fault.message })
}
