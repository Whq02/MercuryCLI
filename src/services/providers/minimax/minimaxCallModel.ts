import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { thinkingOffWireEffort, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { MINIMAX_ENV_KEY, minimaxChatCompletionsUrl, resolveMinimaxAccount, resolveMinimaxApiKey } from './minimaxAccounts.js'
import { getCachedMinimaxCatalogue, minimaxListedModel, minimaxModelFacts, minimaxWireId, newestMinimaxModel } from './minimaxCatalogue.js'
import { MINIMAX_DISPLAY_PINS, isMinimaxTextModelId, minimaxDisplayPin } from './minimaxPins.js'

export function buildMinimaxExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const facts = minimaxModelFacts(args.wireModel)
  const effort = facts.thinking !== 'tunable' ? undefined
    : !args.thinkingEnabled ? thinkingOffWireEffort(facts.efforts)
      : args.effortValue !== undefined ? nearestSupportedWireEffort(args.effortValue, facts.efforts) : undefined
  return {
    reasoning_split: true,
    stream_options: { include_usage: true },
    ...(facts.thinking === 'toggle' ? { thinking: { type: args.thinkingEnabled ? 'adaptive' : 'disabled' } } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_completion_tokens: args.maxOutputTokensOverride } : {}),
  }
}

const minimaxLaneProfile: CompatLaneProfile = {
  lane: 'minimax', providerLabel: 'MiniMax',
  resolveCredential: () => {
    const key = resolveMinimaxApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('minimax')) return null
    const fresh = recoverProviderKeyCommand('minimax')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('minimax')
    return failure ? `the configured ${failure.message} — no MiniMax API key detected.` : `no MiniMax API key detected — /logins minimax stores one (made at platform.minimax.io/user-center, Account Management → API Keys); ${MINIMAX_ENV_KEY} works too.`
  },
  authRemedy: `set a valid ${MINIMAX_ENV_KEY}, or /logins minimax stores a new key from platform.minimax.io/user-center (an M Plan Subscription Key from platform.minimax.io/console/plan works too).`,
  billingRemedy: 'the Open Platform balance is spent or the M Plan window is used up — top up at platform.minimax.io or wait for the window to reset, then retry; /model picks another model meanwhile.',
  requestUrl: () => minimaxChatCompletionsUrl(),
  wireModelId: model => minimaxWireId(model),
  toolCapabilityRefusal: model => minimaxModelFacts(model).tools === false ? `MiniMax model '${model}' does not support tool calls.` : undefined,
  keepsReasoningHistory: () => true,
  buildExtras: buildMinimaxExtras,
  onResponseHeaders: (_headers, status) => {
    if (status === undefined || status < 200 || status >= 300) return
    void refreshProviderUsage('minimax', { reason: 'operator' }).catch(() => {})
  },
}

export function minimaxLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('minimax')
}

export async function* minimaxCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const account = resolveMinimaxAccount()
  if (!account) {
    yield* compatChatCallModel(minimaxLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('minimax'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedMinimaxCatalogue()
  const asked = normalizeModelStringForAPI(params.options.model)
  const model = asked.trim().toLowerCase() === 'minimax' ? newestMinimaxModel() : minimaxListedModel(snapshot, asked)?.id ?? minimaxWireId(asked)
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins minimax replaces the key.`
  else if (!model) refusal = "MiniMax cannot resolve 'minimax' until the account's live list serves a text model; /model refreshes the list."
  else if (!isMinimaxTextModelId(model)) refusal = `MiniMax model '${model}' is not on the text road; the video, speech, music and image lines are not supported here.`
  else if (snapshot && snapshot.models.length > 0 && !minimaxListedModel(snapshot, model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, snapshot.models.map(row => row.id))
  } else if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !minimaxDisplayPin(model)) {
    refusal = modelNotOfferedByCatalogue(model, account.label, MINIMAX_DISPLAY_PINS.map(pin => pin.wireId))
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.models.length ? [`MiniMax model list unavailable — the named id '${model}' is sent for the provider to decide.`] : undefined
  yield* compatChatCallModel({
    ...minimaxLaneProfile, ...(notes ? { leadingNotes: notes } : {}), wireModelId: () => model!,
  }, { ...params, options: { ...params.options, model: model! } })
}
