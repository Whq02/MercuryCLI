import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { buildXaiExtras } from '../openaicompat/compatWire.js'
import { xaiChatCompletionsUrl, xaiGrokProxyChatHeaders, resolveXaiCredential, resolveXaiAccount } from './xaiAccounts.js'
import { getCachedXaiCatalogue, xaiModelFacts } from './xaiCatalogue.js'
import { isXaiChatModelId } from './xaiPins.js'
import { refreshXaiTokens } from './xaiOauth.js'
import { xaiResponsesTransport } from './xaiResponsesTransport.js'

export const xaiLaneProfile: CompatLaneProfile = {
  lane: 'xai',
  providerLabel: 'xAI',
  resolveCredential: async () => {
    try {
      const key = await resolveXaiCredential()
      return key ? { apiKey: key.key, requestUrl: xaiChatCompletionsUrl(undefined, key.source) } : undefined
    } catch { return undefined }
  },
  credentialHint: 'no usable Grok sign-in or xAI API key — /logins xai reconnects the subscription or stores a key; XAI_API_KEY works too.',
  authRemedy: 'set a valid XAI_API_KEY, or store a new key via /logins xai (console.x.ai issues them).',
  billingRemedy: 'check credits and billing at console.x.ai, then retry; /model picks another model meanwhile.',
  requestUrl: () => xaiChatCompletionsUrl(),
  wireModelId: modelId => modelId,
  usageForSettlement: usage => ({ ...usage, outputTokens: Math.max(usage.outputTokens, (usage.totalTokens ?? 0) - usage.inputTokens) }),
  toolCapabilityRefusal: model => xaiModelFacts(model)?.tools === false ? `xAI model '${model}' does not support tool calls.` : undefined,
  buildExtras: args => buildXaiExtras({ ...args, vocabulary: xaiModelFacts(args.wireModel)?.efforts ?? [] }),
}
export function xaiLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('xai')
}
export async function* xaiCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveXaiAccount()
  if (!account) {
    yield* compatChatCallModel(xaiLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('xai'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedXaiCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const alias = asked.trim().toLowerCase() === 'grok'
  const model = alias ? snapshot?.models[0]?.id : asked
  let refusal: string | undefined
  if (!model) refusal = `xAI cannot resolve 'grok' until the account's live list serves a chat model${snapshot?.lastError ? ` — ${snapshot.lastError}` : ''}; /model refreshes the list.`
  else if (!isXaiChatModelId(model)) refusal = `xAI model '${model}' is not on the chat-completions road; image, video, audio and multi-agent endpoints are not supported here.`
  else if (snapshot?.lastError?.includes('refused the credential')) refusal = `${snapshot.lastError} — /logins xai replaces the key.`
  else if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.models.some(row => row.id.toLowerCase() === model.toLowerCase() || row.aliases?.some(id => id.toLowerCase() === model.toLowerCase()))) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}` })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.fetchedAtMs ? [`xAI model list unavailable — the named id '${model}' is sent for the provider to decide.`] : undefined
  const subscription = account.kind === 'grok-subscription'
  yield* compatChatCallModel({ ...xaiLaneProfile,
    ...(subscription ? { streamTransport: xaiResponsesTransport,
      extraHeaders: () => xaiGrokProxyChatHeaders(model!),
      recoverCredential: async () => {
        if (resolveXaiAccount()?.kind !== 'grok-subscription') return undefined
        const tokens = await refreshXaiTokens(undefined, true)
        return tokens ? { apiKey: tokens.accessToken, requestUrl: xaiChatCompletionsUrl(undefined, 'oauth') } : undefined
      },
      authRemedy: '/logins xai reconnects your Grok subscription; xAI decides eligibility for this account.',
      billingRemedy: 'check the subscription pool in your Grok account; /model picks another model meanwhile.',
    } : {}),
    resolveCredential: async () => {
      if (resolveXaiAccount()?.kind !== account.kind) return undefined
      return xaiLaneProfile.resolveCredential()
    },
    ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!
  }, { ...params, options: { ...params.options, model: model! } })
}
