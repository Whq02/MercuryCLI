import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { toolDeclarationRowInResult } from '../zai/zaiCodec.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { QWEN_BASE_OVERRIDE_ENV, QWEN_ENV_KEY, qwenBoundEndpointLabel, qwenChatCompletionsUrl, resolveQwenAccount, resolveQwenApiKey } from './qwenAccounts.js'
import { getCachedQwenCatalogue, newestQwenModel, qwenListedModel, qwenModelFacts, qwenWireId } from './qwenCatalogue.js'
import { QWEN_DISPLAY_PINS, isQwenTextModelId, qwenDisplayPin, qwenPreservesThinking, qwenWireEffort } from './qwenPins.js'
import { operatorModelFacts } from '../../../utils/model/modelOverrides.js'

export const QWEN_KEY_PAGE = 'modelstudio.alibabacloud.com (API-KEY)'

export function buildQwenExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const facts = qwenModelFacts(args.wireModel)
  const thinks = facts.thinking === 'hybrid' && args.thinkingEnabled
  const budget = thinks ? operatorModelFacts(args.wireModel)?.thinkingBudget : undefined
  const effort = thinks && budget === undefined && facts.efforts.length > 0 && args.effortValue !== undefined ? qwenWireEffort(args.effortValue) : undefined
  return {
    stream_options: { include_usage: true },
    ...(facts.thinking === 'hybrid' ? { enable_thinking: args.thinkingEnabled } : {}),
    ...(facts.preservesThinking ? { preserve_thinking: true } : {}),
    ...(budget !== undefined ? { thinking_budget: budget } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export function qwenWrongRegionRemedy(endpointLabel: string | undefined): string {
  const where = endpointLabel ? `Model Studio ${endpointLabel} refused the key` : 'Model Studio refused the key'
  return `${where} — a Model Studio key answers only the region and plan it was minted in; /logins qwen re-binds the key to its endpoint, or ${QWEN_BASE_OVERRIDE_ENV} names the endpoint it was minted for. A 403 "Access to model denied" means the service or the model is not activated for the account — the Model Studio console (Model Gallery) activates it.`
}

const qwenLaneProfile: CompatLaneProfile = {
  lane: 'qwen', providerLabel: 'Qwen',
  resolveCredential: () => {
    const key = resolveQwenApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('qwen')) return null
    const fresh = recoverProviderKeyCommand('qwen')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('qwen')
    return failure ? `the configured ${failure.message} — no Model Studio API key detected.` : `no Model Studio API key detected — /logins qwen stores one (made at ${QWEN_KEY_PAGE}); ${QWEN_ENV_KEY} works too.`
  },
  get authRemedy(): string {
    return qwenWrongRegionRemedy(qwenBoundEndpointLabel())
  },
  billingRemedy: 'the Model Studio balance or plan quota is spent — top up or wait for the plan window at modelstudio.console.alibabacloud.com (Usage & Billing), then retry; /model picks another model meanwhile.',
  requestUrl: () => qwenChatCompletionsUrl(),
  wireModelId: model => qwenWireId(model),
  keepsReasoningHistory: model => qwenPreservesThinking(model),
  buildExtras: buildQwenExtras,
  toolDeclarationRow: toolDeclarationRowInResult,
}

export function qwenLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('qwen')
}

export async function* qwenCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveQwenAccount()
  if (!account) {
    yield* compatChatCallModel(qwenLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('qwen'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedQwenCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const model = asked.trim().toLowerCase() === 'qwen' ? newestQwenModel() : qwenListedModel(snapshot, asked)?.id ?? qwenWireId(asked)
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins qwen re-binds the key.`
  else if (!model) refusal = "Qwen cannot resolve 'qwen' until the account's live list serves a text model; /model refreshes the list."
  else if (!isQwenTextModelId(model)) refusal = `Qwen model '${model}' is not on the text road; the speech, image, video, embedding and rerank lines are not supported here.`
  else if (snapshot && snapshot.models.length > 0 && !qwenListedModel(snapshot, model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  } else if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !qwenDisplayPin(model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, QWEN_DISPLAY_PINS.filter(pin => !pin.planOnly).map(pin => pin.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.models.length ? [`Qwen model list unavailable — the named id '${model}' is sent for Model Studio to decide.`] : undefined
  yield* compatChatCallModel({
    ...qwenLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
  }, { ...params, options: { ...params.options, model: model! } })
}
