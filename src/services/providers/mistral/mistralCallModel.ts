import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { mistralChatCompletionsUrl, resolveMistralAccount, resolveMistralApiKey } from './mistralAccounts.js'
import { getCachedMistralCatalogue, mistralListedModel, mistralModelFacts, newestMistralModel } from './mistralCatalogue.js'
import { isMistralChatModelId } from './mistralPins.js'

export function buildMistralExtras(args: LaneExtrasArgs, outputFormat?: CallModelParams['options']['outputFormat']): Record<string, unknown> {
  const facts = mistralModelFacts(args.wireModel)
  return {
    ...(outputFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: outputFormat.schema } } } : {}),
    ...(facts.reasoning === true ? { reasoning_effort: args.thinkingEnabled ? 'high' : 'none' } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export const mistralLaneProfile: CompatLaneProfile = {
  lane: 'mistral', providerLabel: 'Mistral',
  resolveCredential: () => {
    const key = resolveMistralApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint: 'no Mistral API key detected — /logins mistral stores one; MISTRAL_API_KEY works too.',
  authRemedy: 'set a valid MISTRAL_API_KEY, or /logins mistral stores a new key from console.mistral.ai/api-keys.',
  billingRemedy: 'the included monthly usage or the spend limit is exhausted — check admin.mistral.ai/subscription (pay-as-you-go is a switch there), then retry; /model picks another model meanwhile.',
  requestUrl: () => mistralChatCompletionsUrl(),
  wireModelId: model => model,
  toolCapabilityRefusal: model => mistralModelFacts(model).tools === false ? `Mistral model '${model}' does not support tool calls.` : undefined,
  buildExtras: buildMistralExtras,
}

export function mistralLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('mistral')
}

export async function* mistralCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveMistralAccount()
  if (!account) {
    yield* compatChatCallModel(mistralLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('mistral'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedMistralCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const model = asked.trim().toLowerCase() === 'mistral' ? newestMistralModel() : mistralListedModel(snapshot, asked)?.id ?? asked
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins mistral replaces the key.`
  else if (!model) refusal = "Mistral cannot resolve 'mistral' until the account's live list serves a chat model; /model refreshes the list."
  else if (!isMistralChatModelId(model)) refusal = `Mistral model '${model}' is not on the chat-completions road; embedding, OCR, moderation and audio endpoints are not supported here.`
  else if (snapshot && snapshot.fetchedAtMs > 0 && !mistralListedModel(snapshot, model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.fetchedAtMs ? [`Mistral model list unavailable — the named id '${model}' is sent for the provider to decide.`] : undefined
  yield* compatChatCallModel({
    ...mistralLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
    buildExtras: args => buildMistralExtras(args, params.options.outputFormat),
  }, { ...params, options: { ...params.options, model: model! } })
}
