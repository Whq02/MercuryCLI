// ============================================================================
//  providers/gemini/geminiCallModel — the Gemini dispatch runtime.
//
//  Gemini rides the shared chat-completions runtime through Google's OpenAI-
//  compatibility surface (v1beta/openai/chat/completions), where bearer auth
//  carries either credential kind: the API key directly, or the OAuth access
//  token the lane's ASYNC resolver refreshes before answering (the runtime
//  awaits resolveCredential per call exactly for this shape). Model ids ride
//  as the vendor names them. The response seam folds rate headers into the
//  lane's observed-limit state.
// ============================================================================
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

/** The bearer credential for the compat surface: the raw API key, or the
 *  OAuth access token — recovered from the lane resolver's header record
 *  (its two spellings are its own contract; never logged). */
function bearerFromAuthHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers['authorization'] ?? headers['Authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return headers['x-goog-api-key']
}

export const geminiLaneProfile: CompatLaneProfile = {
  lane: 'gemini',
  providerLabel: 'Gemini',
  // ASYNC (the widened resolveCredential contract): the resolver refreshes
  // an expiring OAuth token before answering.
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
  // Refresh-on-401 for the OAuth source: force the token refresh (a token
  // the local clock vouched for was refused) and answer the fresh bearer;
  // an API key has nothing to recover.
  recoverCredential: async () => {
    // A key has no refresh route — null, so the refusal never claims an attempt.
    if (resolveGeminiAccount()?.kind !== 'oauth') return null
    const auth = await resolveGeminiRequestAuth({ sourceKind: 'oauth', forceRefresh: true })
    if (!auth) return undefined
    const bearer = bearerFromAuthHeaders(auth.headers)
    return bearer ? { apiKey: bearer } : undefined
  },
  requestUrl: () => `${geminiApiBase()}/openai/chat/completions`,
  wireModelId: modelId => modelId,
  // reasoning_effort rides only for rows the LIVE catalogue states as
  // thinking models (geminiEffortVocabularyFor — the same read the
  // capability edge offers the operator): display equals dispatch.
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

/** The provider-aware callModel branch for Gemini. */
export async function* geminiCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(geminiLaneProfile, params)
}
