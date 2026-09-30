import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatCallModelParams, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { metaChatCompletionsUrl, resolveMetaApiKey, resolveMetaAccount } from './metaAccounts.js'
import { getCachedMetaCatalogue, newestMetaModel } from './metaCatalogue.js'
import { isMetaChatModelId, metaDisplayPin } from './metaPins.js'

export function buildMetaExtras(args: LaneExtrasArgs, outputFormat?: CompatCallModelParams['options']['outputFormat']): Record<string, unknown> {
  const vocabulary = metaDisplayPin(args.wireModel)?.efforts ?? []
  const effort = vocabulary.length && args.effortValue !== undefined
    ? nearestSupportedWireEffort(args.effortValue, vocabulary)
    : undefined
  return {
    stream_options: { include_usage: true },
    ...(outputFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: outputFormat.schema } } } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_completion_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export const metaLaneProfile: CompatLaneProfile = {
  lane: 'meta', providerLabel: 'Meta',
  resolveCredential: () => {
    const key = resolveMetaApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint: 'no Meta Model API key detected — /logins meta stores one; MODEL_API_KEY works too.',
  authRemedy: 'set a valid MODEL_API_KEY, or /logins meta stores a new Model API key from dev.meta.ai.',
  billingRemedy: 'check pay-as-you-go billing at dev.meta.ai; Muse Code subscriptions do not cover third-party clients.',
  requestUrl: () => metaChatCompletionsUrl(),
  wireModelId: model => model,
  buildExtras: buildMetaExtras,
}

export function metaLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('meta')
}

export async function* metaCallModel(params: CompatCallModelParams): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  if (params.signal.aborted) return
  const account = resolveMetaAccount()
  if (!account) {
    yield* compatChatCallModel(metaLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('meta'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedMetaCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const model = asked.trim().toLowerCase() === 'muse' ? newestMetaModel() : snapshot?.models.find(row => row.id.toLowerCase() === asked.toLowerCase())?.id ?? asked
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins meta replaces the key.`
  else if (!model) refusal = "Meta cannot resolve 'muse' until the account's live list serves a Standard Muse Spark model; Contributor models permit training on your data and must be selected explicitly. /model refreshes the list."
  else if (!isMetaChatModelId(model)) refusal = `Meta model '${model}' is not a Muse Spark chat model; image generation, transcription and segmentation endpoints are not supported here.`
  else if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.models.some(row => row.id.toLowerCase() === model.toLowerCase())) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.fetchedAtMs ? [`Meta model list unavailable — the named id '${model}' is sent for the provider to decide.`] : undefined
  yield* compatChatCallModel({
    ...metaLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
    buildExtras: args => buildMetaExtras(args, params.options.outputFormat),
  }, { ...params, options: { ...params.options, model: model! } })
}
