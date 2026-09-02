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

function bearerFromAuthHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers['authorization'] ?? headers['Authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return headers['x-goog-api-key']
}

export const geminiLaneProfile: CompatLaneProfile = {
  lane: 'gemini',
  providerLabel: 'Gemini',
  resolveCredential: async () => {
    const auth = await resolveGeminiRequestAuth()
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
  recoverCredential: async () => {
    if (resolveGeminiAccount()?.kind !== 'oauth') return null
    const auth = await resolveGeminiRequestAuth({ sourceKind: 'oauth', forceRefresh: true })
    if (!auth) return undefined
    const bearer = bearerFromAuthHeaders(auth.headers)
    return bearer ? { apiKey: bearer } : undefined
  },
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
  yield* compatChatCallModel(geminiLaneProfile, params)
}
