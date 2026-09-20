import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildGeminiExtras } from '../openaicompat/compatWire.js'
import { geminiApiBase, resolveGeminiAccount, resolveGeminiRequestAuth } from './geminiAccounts.js'
import { geminiEffortVocabularyFor } from './geminiCatalogue.js'
import { recordGeminiRateHeaders } from './geminiUsageState.js'
import { streamGeminiContent } from './geminiClient.js'
import type { GeminiTurnItem } from './geminiCodec.js'
import { mapMessagesToZai } from '../zai/zaiCodec.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { compatDispatchModelId } from '../openaicompat/compatChatCallModel.js'

function bearerFromAuthHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers['authorization'] ?? headers['Authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return headers['x-goog-api-key']
}

export const geminiLaneProfile: CompatLaneProfile = {
  lane: 'gemini',
  providerLabel: 'Gemini',
  resolveCredential: async () => {
    const auth = await resolveGeminiRequestAuth({ sourceKind: 'api-key' })
    if (!auth) return undefined
    const bearer = bearerFromAuthHeaders(auth.headers)
    return bearer ? { apiKey: bearer } : undefined
  },
  credentialHint:
    'no Gemini credential detected — /logins adds Gemini (API key, or Google OAuth with your own client).',
  authRemedy:
    'set a valid GEMINI_API_KEY (or GOOGLE_API_KEY), or /logins reconnects Gemini — a fresh key, or the Google account again.',
  billingRemedy:
    'check the billing and quota of the Google Cloud project behind this key, then retry; /model picks another model meanwhile.',
  requestUrl: () => `${geminiApiBase()}/openai/chat/completions`,
  wireModelId: modelId => modelId,
  buildExtras: args =>
    buildGeminiExtras({
      ...args,
      acceptsEffort: geminiEffortVocabularyFor(args.wireModel).length > 0,
    }),
  onResponseHeaders: headers => {
    recordGeminiRateHeaders(headers)
  },
}

export function geminiLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('gemini')
}

export async function* geminiCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  if (resolveGeminiAccount()?.kind !== 'oauth') {
    yield* compatChatCallModel(geminiLaneProfile, params)
    return
  }
  const model = compatDispatchModelId(params.options.model)
  let bearer: string | undefined
  let status: number | undefined
  let recovery: 'retried' | 'no-new-credential' | undefined
  const profile: CompatLaneProfile = {
    ...geminiLaneProfile,
    resolveCredential: async () => {
      const auth = await resolveGeminiRequestAuth({ sourceKind: 'oauth' })
      if (!auth) return undefined
      bearer = bearerFromAuthHeaders(auth.headers)
      return bearer ? { apiKey: bearer, requestUrl: `${auth.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` } : undefined
    },
    recoverCredential: async () => {
      recovery = 'no-new-credential'
      const auth = await resolveGeminiRequestAuth({ sourceKind: 'oauth', forceRefresh: true })
      if (!auth) return undefined
      const fresh = bearerFromAuthHeaders(auth.headers)
      if (fresh && fresh !== bearer) recovery = 'retried'
      return fresh ? { apiKey: fresh, requestUrl: `${auth.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` } : undefined
    },
    onResponseHeaders: (headers, responseStatus) => {
      status = responseStatus
      recordGeminiRateHeaders(headers)
    },
    streamTransport: (options, messages) => {
      let turn: GeminiTurnItem | undefined
      return {
        events: streamGeminiContent({ ...options, messages, onTurn: item => { turn = item } }),
        settle: minted => {
          const last = minted.at(-1)
          if (!last || !turn) return
          const content = minted.flatMap(message => message.message.content)
          const projection = JSON.stringify(mapMessagesToZai(undefined, [{ role: 'assistant', content }])[0])
          const refused = minted.flatMap(message => message.refusedToolCalls ?? []).map(call => ({ id: call.id, reason: call.reason }))
          last.geminiProviderTurn = { ...turn, projection, ...(refused.length ? { refused } : {}) }
        },
      }
    },
  }
  for await (const item of compatChatCallModel(profile, params)) {
    if (item.type === 'assistant' && item.isApiErrorMessage && item.error === 'authentication_failed') {
      const refreshed = recovery === 'retried'
        ? ' The stored token was refreshed and the call retried once before this refusal.'
        : recovery === 'no-new-credential' ? ' A token refresh was attempted first and produced no new credential.' : ''
      yield createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: the Google account's token was refused${status === undefined ? '' : ` (HTTP ${status})`} · /logins re-connects the Google account; /model picks another model meanwhile.${refreshed}`,
        error: item.error,
        errorDetails: item.errorDetails,
      })
    } else yield item
  }
}
