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
  recoverCredential: async () => {
    if (process.env.HF_TOKEN?.trim() || !huggingfaceStoredTokens()?.refreshToken) return null
    const fresh = await refreshHuggingfaceTokens()
    return fresh ? { apiKey: fresh.accessToken } : undefined
  },
  requestUrl: () => huggingfaceChatCompletionsUrl(),
  wireModelId: modelId => qualifiedWireId(modelId),
  buildExtras: buildHuggingfaceExtras,
  extraHeaders: () => {
    const billTo = huggingfaceBillTo()
    return billTo ? { 'X-HF-Bill-To': billTo } : undefined
  },
  toolCapabilityRefusal: wireModel => {
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

export async function* huggingfaceCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(huggingfaceLaneProfile, params)
}
