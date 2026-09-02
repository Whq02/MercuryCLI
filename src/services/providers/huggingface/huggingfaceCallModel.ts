// ============================================================================
//  providers/huggingface/huggingfaceCallModel — the Hugging Face lane profile
//  over the shared OpenAI-compatible runtime.
// ----------------------------------------------------------------------------
//  Wire facts (huggingface.co/docs/inference-providers, fetched):
//    · POST https://router.huggingface.co/v1/chat/completions, Bearer token
//      (HF_TOKEN / an OAuth access token with the inference-api scope / a
//      fine-grained token with the Inference Providers permission);
//    · the model is the Hub slug with an optional `:provider` / `:policy`
//      suffix — the router picks the fastest live provider by default;
//    · streaming SSE in the OpenAI chunk shape; tools as functions with
//      tool_choice auto|none|required; stream_options.include_usage delivers
//      {prompt_tokens, completion_tokens, total_tokens} before [DONE];
//    · X-HF-Bill-To names an organization (Team/Enterprise credits) when the
//      operator pins one;
//    · a 401 answers {"error": "Invalid username or password."} (observed
//     ); 402 (credits exhausted) and 429 shapes are deferred-live.
//  The dispatch is UNVERIFIED against a live endpoint until the receipt's
//  deferred-live checklist closes — the readiness detail says so.
// ============================================================================
import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildHuggingfaceExtras } from '../openaicompat/compatWire.js'
import { qualifiedWireId } from '../routeLaw.js'
import {
  huggingfaceBillTo,
  huggingfaceChatCompletionsUrl,
  huggingfaceStoredTokens,
  refreshHuggingfaceTokens,
  resolveHuggingfaceDispatchCredential,
} from './huggingfaceAccounts.js'
import { huggingfaceLiveSupportsTools, refreshHuggingfaceCatalogue } from './huggingfaceCatalogue.js'
import { recordHuggingfaceBillingStatus, recordHuggingfaceRateHeaders } from './huggingfaceUsageState.js'

export const HUGGINGFACE_UNVERIFIED_NOTE = 'unverified against a live endpoint'

export const huggingfaceLaneProfile: CompatLaneProfile = {
  lane: 'huggingface',
  providerLabel: 'Hugging Face',
  resolveCredential: () => resolveHuggingfaceDispatchCredential(),
  credentialHint:
    'no Hugging Face credential detected — /logins connects Hugging Face (device-code sign-in or a pasted token), or set HF_TOKEN.',
  authRemedy:
    'set a valid HF_TOKEN (a token with the Inference Providers permission), or /logins reconnects Hugging Face (device-code sign-in or a pasted token).',
  billingRemedy:
    'the Inference Providers credits are exhausted — add credits to the account, or bill an organization with credits via MERCURY_HUGGINGFACE_BILL_TO, then retry.',
  // Refresh-on-401 for the OAuth source (HF_TOKEN has nothing to recover):
  // force the refresh and answer the rotated access token.
  recoverCredential: async () => {
    // An env token or a sign-in without a refresh token has no refresh
    // route — null, so the refusal never claims an attempt.
    if (process.env.HF_TOKEN?.trim() || !huggingfaceStoredTokens()?.refreshToken) return null
    const fresh = await refreshHuggingfaceTokens()
    return fresh ? { apiKey: fresh.accessToken } : undefined
  },
  requestUrl: () => huggingfaceChatCompletionsUrl(),
  // Persisted ids are provider-qualified ('huggingface/<org>/<model>[:suffix]');
  // the router receives the Hub slug verbatim.
  wireModelId: modelId => qualifiedWireId(modelId),
  buildExtras: buildHuggingfaceExtras,
  extraHeaders: () => {
    const billTo = huggingfaceBillTo()
    return billTo ? { 'X-HF-Bill-To': billTo } : undefined
  },
  toolCapabilityRefusal: wireModel => {
    // The live catalogue states supports_tools per provider; a model whose
    // reachable providers all state false cannot run a tool-bearing turn.
    if (huggingfaceLiveSupportsTools(wireModel) === false) {
      return `Hugging Face lists '${wireModel}' without tool-call support on its reachable providers — pick a tool-capable model for tool-bearing roles (the router catalogue marks supports_tools per provider).`
    }
    return undefined
  },
  onResponseHeaders: (headers, status) => {
    recordHuggingfaceRateHeaders(headers, status)
    recordHuggingfaceBillingStatus(status)
    void refreshHuggingfaceCatalogue().catch(() => {})
  },
}

export function huggingfaceLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('huggingface')
}

/** The provider-aware callModel branch for Hugging Face. */
export async function* huggingfaceCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(huggingfaceLaneProfile, params)
}
