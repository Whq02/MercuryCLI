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
import { QWEN_BASE_OVERRIDE_ENV, QWEN_ENV_KEY, qwenBoundEndpointLabel, qwenChatCompletionsUrl, qwenSigninActive, resolveQwenAccount, resolveQwenCredential } from './qwenAccounts.js'
import { QWEN_SIGNIN_EXPIRED_LINE, qwenSigninRefusal, qwenSigninRefusalNote, refreshQwenTokens } from './qwenOauth.js'
import { getCachedQwenCatalogue, newestQwenModel, qwenListedModel, qwenModelFacts, qwenPinScope, qwenWireId } from './qwenCatalogue.js'
import { isQwenTextModelId, qwenDisplayPin, qwenPinsFor, qwenPreservesThinking, qwenWireEffort } from './qwenPins.js'
import { operatorModelFacts } from '../../../utils/model/modelOverrides.js'

const QWEN_KEY_PAGE = 'modelstudio.alibabacloud.com (API-KEY)'

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

function qwenWrongRegionRemedy(endpointLabel: string | undefined): string {
  const where = endpointLabel ? `Model Studio ${endpointLabel} refused the key` : 'Model Studio refused the key'
  return `${where} — a Model Studio key answers only the region and plan it was minted in; /logins qwen re-binds the key to its endpoint, or ${QWEN_BASE_OVERRIDE_ENV} names the endpoint it was minted for. A 403 "Access to model denied" means the service or the model is not activated for the account — the Model Studio console (Model Gallery) activates it.`
}

const qwenLaneProfile: CompatLaneProfile = {
  lane: 'qwen', providerLabel: 'Qwen',
  resolveCredential: async () => {
    const credential = await resolveQwenCredential()
    return credential ? { apiKey: credential.apiKey, requestUrl: credential.requestUrl } : undefined
  },
  recoverCredential: async () => {
    if (qwenSigninActive()) {
      const fresh = await refreshQwenTokens(undefined, true).catch(() => undefined)
      if (!fresh) return undefined
      const credential = await resolveQwenCredential()
      return credential ? { apiKey: credential.apiKey, requestUrl: credential.requestUrl } : undefined
    }
    if (!configuredProviderKeyCommand('qwen')) return null
    const fresh = recoverProviderKeyCommand('qwen')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    if (qwenSigninActive()) {
      const refusal = qwenSigninRefusal()
      return refusal ? `${qwenSigninRefusalNote(refusal)}.` : `${QWEN_SIGNIN_EXPIRED_LINE}.`
    }
    const failure = providerKeyCommandFailure('qwen')
    return failure ? `the configured ${failure.message} — no Model Studio API key detected.` : `no Model Studio API key detected — /logins qwen stores one (made at ${QWEN_KEY_PAGE}) or signs in with a Qwen account; ${QWEN_ENV_KEY} works too.`
  },
  get authRemedy(): string {
    if (qwenSigninActive()) return `${QWEN_SIGNIN_EXPIRED_LINE}.`
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
  const chosen = asked.trim().toLowerCase() === 'qwen' ? newestQwenModel() : asked
  const pin = chosen === undefined ? undefined : qwenDisplayPin(chosen)
  const model = chosen === undefined ? undefined : qwenListedModel(snapshot, chosen)?.id ?? qwenWireId(chosen)
  const scope = qwenPinScope(process.env, snapshot)
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = qwenSigninActive() ? `${qwenSigninRefusal() ? qwenSigninRefusalNote(qwenSigninRefusal()!) : QWEN_SIGNIN_EXPIRED_LINE}.` : `${snapshot!.lastError} — /logins qwen re-binds the key.`
  else if (!model || !chosen) refusal = "Qwen cannot resolve 'qwen' until the account's list serves a text model; /model refreshes the list."
  else if (!isQwenTextModelId(chosen)) refusal = `Qwen model '${chosen}' is not on the text road; the speech, image, video, embedding and rerank lines are not supported here.`
  else if (scope !== 'coding-plan' && snapshot && snapshot.models.length > 0 && !qwenListedModel(snapshot, chosen) && !pin) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  } else if (scope !== 'coding-plan' && snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !pin) {
    refusal = modelNotOfferedByCatalogue(model, account.label, qwenPinsFor(scope).map(row => row.id))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.models.length
    ? [`Qwen model list unavailable — the named id '${model}' is sent for Model Studio to decide.`]
    : scope !== 'coding-plan' && !qwenListedModel(snapshot, chosen!) ? [`'${model}' is a pinned Model Studio id the endpoint's list does not name — sent for Model Studio to decide.`] : undefined
  yield* compatChatCallModel({
    ...qwenLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
  }, { ...params, options: { ...params.options, model: model! } })
}
