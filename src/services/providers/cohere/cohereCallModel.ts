import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { COHERE_ENV_KEY, cohereChatCompletionsUrl, resolveCohereAccount, resolveCohereApiKey } from './cohereAccounts.js'
import { cohereListedModel, cohereModelFacts, getCachedCohereCatalogue, newestCohereModel } from './cohereCatalogue.js'
import { COHERE_DISPLAY_PINS, cohereDisplayPin, isCohereChatModelId } from './coherePins.js'

export function buildCohereExtras(args: LaneExtrasArgs, outputFormat?: CallModelParams['options']['outputFormat']): Record<string, unknown> {
  const facts = cohereModelFacts(args.wireModel)
  return {
    ...(outputFormat ? { response_format: { type: 'json_object', schema: outputFormat.schema } } : {}),
    ...(facts.reasoning === true ? { reasoning_effort: args.thinkingEnabled ? 'high' : 'none' } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

const cohereLaneProfile: CompatLaneProfile = {
  lane: 'cohere', providerLabel: 'Cohere',
  resolveCredential: () => {
    const key = resolveCohereApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('cohere')) return null
    const fresh = recoverProviderKeyCommand('cohere')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('cohere')
    return failure ? `the configured ${failure.message} — no Cohere API key detected.` : `no Cohere API key detected — /logins cohere stores one (made at dashboard.cohere.com/api-keys); ${COHERE_ENV_KEY} works too.`
  },
  authRemedy: `set a valid ${COHERE_ENV_KEY}, or /logins cohere stores a new key from dashboard.cohere.com/api-keys.`,
  billingRemedy: 'the Cohere account cannot be billed for this request — a trial key is rate-limited and non-commercial, a production key bills pay-as-you-go at dashboard.cohere.com/billing; fix the account there, then retry; /model picks another model meanwhile.',
  requestUrl: () => cohereChatCompletionsUrl(),
  wireModelId: model => model,
  toolCapabilityRefusal: model => cohereModelFacts(model).tools === false ? `Cohere model '${model}' does not support tool calls.` : undefined,
  buildExtras: buildCohereExtras,
}

export function cohereLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('cohere')
}

export async function* cohereCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveCohereAccount()
  if (!account) {
    yield* compatChatCallModel(cohereLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('cohere'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedCohereCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const model = asked.trim().toLowerCase() === 'cohere' ? newestCohereModel() : cohereListedModel(snapshot, asked)?.id ?? asked
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins cohere replaces the key.`
  else if (!model) refusal = "Cohere cannot resolve 'cohere' until the account's live list serves a chat model; /model refreshes the list."
  else if (!isCohereChatModelId(model)) refusal = `Cohere model '${model}' is not on the chat-completions road; the embed, rerank and classify endpoints are not supported here.`
  else if (snapshot && snapshot.models.length > 0 && !cohereListedModel(snapshot, model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  } else if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !cohereDisplayPin(model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, COHERE_DISPLAY_PINS.map(pin => pin.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.models.length ? [`Cohere model list unavailable — the named id '${model}' is sent for the provider to decide.`] : undefined
  yield* compatChatCallModel({
    ...cohereLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
    buildExtras: args => buildCohereExtras(args, params.options.outputFormat),
  }, { ...params, options: { ...params.options, model: model! } })
}
