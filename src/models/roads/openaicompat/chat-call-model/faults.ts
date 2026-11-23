import { compatEngineRefusalText, llamacppOriginRemedy } from '../compatRefusals.js'
import type {
  AssistantMessage,
  BusyRefusalV1,
} from '../../../../engine/message-shapes/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../../engine/requests/apiErrorRows.js'
import { estimateRequestTokens } from '../../streamIdleBudget.js'
import { providerWaitIsWindow, providerWaitWords, statedResetWordsOf } from '../../../../engine/requests/recoveryBudget.js'
import { classifyOverflowFault, type OverflowSignal } from '../../../../engine/requests/overflowSignal.js'
import {
  createAssistantAPIErrorMessage,
} from '../../../../engine/messages/messages.js'
import { getContextWindowForModel } from '../../../facts/capabilities.js'
import type { MediaRefusal } from '../../../../engine/request-parts/mediaRefusal.js'
import {
  type CompatChatRequest,
  type CompatFault,
} from '../compatChatClient.js'
import type { CompatLaneProfile } from './lane.js'

export function apiErrorMessage(
  content: string,
  error: NonNullable<AssistantMessage['error']> = 'unknown',
  errorDetails?: string,
  overflow?: OverflowSignal | null,
  busyRefusal?: BusyRefusalV1 | null,
  mediaRefusal?: MediaRefusal | null,
): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content,
    error,
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
    ...(busyRefusal !== undefined ? { busyRefusal } : {}),
    ...(mediaRefusal !== undefined ? { mediaRefusal } : {}),
  })
}

export function overflowOf(
  profile: Pick<CompatLaneProfile, 'lane' | 'servedWindowTokens'>,
  fault: Pick<CompatFault, 'code' | 'message' | 'wireMessage'> & { status?: number },
  sent: { request: CompatChatRequest; model: string },
): OverflowSignal | null {
  return classifyOverflowFault({
    family: profile.lane,
    status: fault.status,
    code: fault.code,
    message: fault.wireMessage ?? fault.message,
    measured: () => ({
      tokens: estimateRequestTokens(sent.request),
      window: profile.servedWindowTokens?.() ?? getContextWindowForModel(sent.model),
    }),
  })
}

type TypedError = NonNullable<AssistantMessage['error']>

const GOOGLE_STATUS_CLASS: Record<string, TypedError> = {
  UNAUTHENTICATED: 'authentication_failed',
  PERMISSION_DENIED: 'authentication_failed',
  RESOURCE_EXHAUSTED: 'rate_limit',
  INVALID_ARGUMENT: 'invalid_request',
  FAILED_PRECONDITION: 'invalid_request',
  NOT_FOUND: 'invalid_request',
  UNAVAILABLE: 'server_error',
  INTERNAL: 'server_error',
  DEADLINE_EXCEEDED: 'server_error',
}

function zaiCodeClass(code: number): TypedError | undefined {
  if (code >= 1000 && code <= 1005) return 'authentication_failed'
  if (code === 1113) return 'billing_error'
  if (code === 1302 || code === 1305) return 'rate_limit'
  if (code === 1211 || code === 1301) return 'invalid_request'
  return undefined
}

const ZEN_BILLING_WORDS = /^(?:api|openai)-(?:CreditsError|MonthlyLimitError|UserLimitError)$/

function minimaxCodeClass(code: number): TypedError | undefined {
  if (code === 1004 || code === 2049) return 'authentication_failed'
  if (code === 1008) return 'billing_error'
  if (code === 1002 || code === 1039 || code === 1041 || code === 2045 || code === 2056) return 'rate_limit'
  if (code === 2013 || code === 1026 || code === 1027 || code === 1042) return 'invalid_request'
  if (code === 1000 || code === 1001 || code === 1013 || code === 1024 || code === 1033) return 'server_error'
  return undefined
}

function vendorWordClass(code: string): TypedError | undefined {
  const zai = /^zai-(\d+)$/.exec(code)
  if (zai) return zaiCodeClass(Number(zai[1]))
  const minimax = /^minimax-(\d+)$/.exec(code)
  if (minimax) return minimaxCodeClass(Number(minimax[1]))
  if (ZEN_BILLING_WORDS.test(code)) return 'billing_error'
  if (!code.startsWith('api-')) return undefined
  const word = code.slice('api-'.length)
  const google = GOOGLE_STATUS_CLASS[word]
  if (google) return google
  if (/rate[-_]?limit|quota|exhausted/i.test(word)) return 'rate_limit'
  if (/insufficient[-_]?(credit|balance|fund)|billing|payment|balance|arrearage/i.test(word)) return 'billing_error'
  if (/auth|api[-_]?key|permission|forbidden/i.test(word)) return 'authentication_failed'
  if (/invalid|bad[-_]?request|not[-_]?found|unsupported|unprocessable/i.test(word)) {
    return 'invalid_request'
  }
  if (/overload|unavailable|server[-_]?error|internal|timeout/i.test(word)) return 'server_error'
  return undefined
}

export function compatFaultToTypedError(
  fault: Pick<CompatFault, 'code' | 'classification'> & { kind: string; status?: number },
): TypedError {
  if (fault.classification !== undefined) return fault.classification
  const { kind, code, status } = fault
  const word = vendorWordClass(code)
  if (word === 'authentication_failed' || word === 'billing_error' || word === 'rate_limit') {
    return word
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'authentication_failed'
    if (status === 402) return 'billing_error'
    if (status === 429) return 'rate_limit'
    if (status === 408 || status >= 500) return 'server_error'
    if (status >= 400) return 'invalid_request'
  }
  if (word !== undefined) return word
  if (code === 'http-429') return 'rate_limit'
  if (/^http-40[13]$/.test(code)) return 'authentication_failed'
  if (code === 'http-402') return 'billing_error'
  if (/^http-4/.test(code)) return 'invalid_request'
  if (kind === 'cancelled') return 'unknown'
  return 'server_error'
}

export function compatTerminalFaultText(
  profile: Pick<CompatLaneProfile, 'providerLabel' | 'credentialHint' | 'authRemedy' | 'billingRemedy' | 'dialect'>,
  fault: Pick<CompatFault, 'code' | 'message' | 'parameter'> & { retryAfterMs?: number; status?: number },
  typed: TypedError,
  opts?: { recovery?: 'retried' | 'no-new-credential'; requestUrl?: string },
): string {
  const detail = fault.message && fault.message !== '' ? `${fault.code}: ${fault.message}` : fault.code
  switch (typed) {
    case 'authentication_failed': {
      const originRemedy = llamacppOriginRemedy(profile.dialect, fault, opts?.requestUrl)
      if (originRemedy !== undefined) return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} refused the request (${detail}) — ${originRemedy}`
      const recovery =
        opts?.recovery === 'retried'
          ? ' The stored token was refreshed and the call retried once before this refusal.'
          : opts?.recovery === 'no-new-credential'
            ? ' A token refresh was attempted first and produced no new credential.'
            : ''
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} rejected the credential (${detail}) — ${profile.authRemedy ?? profile.credentialHint}${recovery}`
    }
    case 'billing_error':
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} reports the account out of credit (${detail}) — ${profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.'}`
    case 'rate_limit': {
      const head = `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} is rate-limiting this account (${detail})`
      if (fault.retryAfterMs !== undefined) {
        const asked = ` — the provider asks for a ${providerWaitWords(fault.retryAfterMs)} wait${providerWaitIsWindow(fault.retryAfterMs) ? ', past the retry budget: a dispatched crewmate pauses until then' : ''}`
        if (fault.retryAfterMs < 60_000) return `${head}${asked} — retry in a moment, or /model picks another model meanwhile.`
        return `${head}${asked}, or /model picks another model meanwhile.`
      }
      const stated = statedResetWordsOf(fault.message ?? '')
      if (stated !== undefined) return `${head} — the provider says the limit resets ${stated}, or /model picks another model meanwhile.`
      return `${head} — retry in a moment, or /model picks another model meanwhile.`
    }
    default: {
      const refusal = compatEngineRefusalText(profile.dialect, fault)
      return refusal ? `${API_ERROR_MESSAGE_PREFIX}: ${refusal}` : `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stream failed (${fault.code}) — ${fault.message}`
    }
  }
}
