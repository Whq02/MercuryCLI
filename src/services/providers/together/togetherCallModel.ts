import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { thinkingOffWireEffort, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { TOGETHER_ENV_KEY, TOGETHER_KEY_PAGE, resolveTogetherAccount, resolveTogetherApiKey, togetherChatCompletionsUrl } from './togetherAccounts.js'
import { cachedLiveIds, getCachedTogetherCatalogue, togetherListedModel } from './togetherCatalogue.js'
import { togetherEffortVocabulary, togetherThinkingDial, togetherWireId } from './togetherPins.js'

export function buildTogetherExtras(args: LaneExtrasArgs & { promptCacheKey?: string }): Record<string, unknown> {
  const dial = togetherThinkingDial(args.wireModel)
  const vocabulary = togetherEffortVocabulary(args.wireModel)
  const effort = vocabulary.length === 0 ? undefined
    : !args.thinkingEnabled ? thinkingOffWireEffort(vocabulary)
      : args.effortValue !== undefined ? nearestSupportedWireEffort(args.effortValue, vocabulary) : undefined
  return {
    stream_options: { include_usage: true },
    ...(args.promptCacheKey !== undefined ? { prompt_cache_key: args.promptCacheKey } : {}),
    ...(dial === 'toggle' ? { reasoning: { enabled: args.thinkingEnabled } } : {}),
    ...(effort !== undefined && (dial === 'effort' || args.thinkingEnabled) ? { reasoning_effort: effort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export const togetherLaneProfile: CompatLaneProfile = {
  lane: 'together',
  providerLabel: 'Together AI',
  resolveCredential: () => {
    const key = resolveTogetherApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint: `no Together AI API key detected — /logins together stores one (made at ${TOGETHER_KEY_PAGE}); ${TOGETHER_ENV_KEY} works too.`,
  authRemedy: `create a key at ${TOGETHER_KEY_PAGE} and store it with /logins together, or set a valid ${TOGETHER_ENV_KEY}.`,
  billingRemedy: 'the Together AI prepaid balance is spent — add credit at api.together.ai/settings/billing, then retry; /model picks another model meanwhile.',
  requestUrl: () => togetherChatCompletionsUrl(),
  wireModelId: model => togetherWireId(model),
  buildExtras: args => buildTogetherExtras({ ...args, promptCacheKey: getSessionId() }),
}

export function togetherLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('together')
}

export async function* togetherCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveTogetherAccount()
  if (!account) {
    yield* compatChatCallModel(togetherLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('together'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedTogetherCatalogue()
  const asked = togetherWireId(params.options.model)
  const wire = togetherListedModel(snapshot, asked)?.id ?? asked
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins together replaces the key.`
  else if (wire === '') refusal = `'${params.options.model.trim()}' names no model inside the together/ namespace — /model lists the live Together AI rows.`
  else if (snapshot && snapshot.fetchedAtMs > 0 && !cachedLiveIds().has(wire.toLowerCase())) {
    refusal = modelNotOfferedByCatalogue(wire, account.label, [...cachedLiveIds()])
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.fetchedAtMs ? [`Together AI model list unavailable — the named id '${wire}' is sent for the gateway to decide.`] : undefined
  yield* compatChatCallModel({
    ...togetherLaneProfile,
    ...(notes ? { leadingNotes: notes } : {}),
    wireModelId: () => wire,
  }, params)
}
