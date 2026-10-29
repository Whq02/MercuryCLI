import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
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
import { clearHuggingfaceUsageLimit, huggingfaceLimitWindow, recordHuggingfaceBillingStatus, recordHuggingfaceRateHeaders } from './huggingfaceUsageState.js'

import { refreshProviderUsage } from '../providerUsage.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'

export const HUGGINGFACE_UNVERIFIED_NOTE = 'unverified against a live endpoint'

export const huggingfaceLaneProfile: CompatLaneProfile = {
  lane: 'huggingface',
  providerLabel: 'Hugging Face',
  resolveCredential: () => resolveHuggingfaceDispatchCredential(),
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('huggingface')
    return failure ? `the configured ${failure.message} — no Hugging Face credential detected.` : 'no Hugging Face credential detected — /logins connects Hugging Face (device-code sign-in or a pasted token), or set HF_TOKEN.'
  },
  authRemedy:
    'set a valid HF_TOKEN (a token with the Inference Providers permission), or /logins reconnects Hugging Face (device-code sign-in or a pasted token).',
  billingRemedy:
    'the Inference Providers credits are exhausted — add credits to the account, or bill an organization with credits via MERCURY_HUGGINGFACE_BILL_TO, then retry.',
  recoverCredential: async () => {
    if (process.env.HF_TOKEN?.trim()) return null
    if (huggingfaceStoredTokens()?.refreshToken) {
      const fresh = await refreshHuggingfaceTokens()
      return fresh ? { apiKey: fresh.accessToken } : undefined
    }
    if (!configuredProviderKeyCommand('huggingface')) return null
    const fresh = recoverProviderKeyCommand('huggingface')
    return fresh ? { apiKey: fresh } : undefined
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
    if (status !== undefined && status >= 200 && status < 300) clearHuggingfaceUsageLimit()
    void refreshHuggingfaceCatalogue().catch(() => {})
  },
}

export function huggingfaceLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('huggingface')
}

export async function* huggingfaceCallModel(params: CallModelParams): CallModelStream {
  if (huggingfaceLimitWindow().state === 'limited') await refreshProviderUsage('huggingface', { force: true, reason: 'operator' })
  yield* compatChatCallModel(huggingfaceLaneProfile, params)
}
