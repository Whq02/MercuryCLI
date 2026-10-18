import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { streamCompatChat } from '../openaicompat/compatChatClient.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { thinkingOffWireEffort, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { fireworksChatCompletionsUrl, resolveFireworksApiKey } from './fireworksAccounts.js'
import { getCachedFireworksCatalogue, fireworksListedModel, fireworksOutputMaxFor } from './fireworksCatalogue.js'
import { fireworksDisplayPin, fireworksEffortVocabulary, fireworksWireId, isFireworksModelId, isFireworksTextModelId } from './fireworksPins.js'
import { fireworksRecordHeaders } from './fireworksUsageState.js'

export function buildFireworksExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const vocabulary = fireworksEffortVocabulary(args.wireModel)
  const requested = args.effortValue === 'minimal' ? 'low' : args.effortValue
  const effort = !args.thinkingEnabled ? thinkingOffWireEffort(vocabulary)
    : requested !== undefined && vocabulary.length > 0 ? nearestSupportedWireEffort(requested, vocabulary) : undefined
  const output = args.maxOutputTokensOverride ?? fireworksOutputMaxFor(args.wireModel)
  return { stream_options: { include_usage: true }, ...(effort !== undefined ? { reasoning_effort: effort } : {}), ...(output !== undefined ? { max_tokens: output } : {}) }
}

const fireworksLaneProfile: CompatLaneProfile = {
  lane: 'fireworks', providerLabel: 'Fireworks',
  resolveCredential: () => {
    const key = resolveFireworksApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('fireworks')) return null
    const fresh = recoverProviderKeyCommand('fireworks')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('fireworks')
    return failure ? `the configured ${failure.message} — no Fireworks API key detected.` : 'no Fireworks API key detected — /logins fireworks stores one from app.fireworks.ai/api-keys; FIREWORKS_API_KEY works too.'
  },
  authRemedy: 'create a current key at app.fireworks.ai/api-keys and store it with /logins fireworks, or set FIREWORKS_API_KEY.',
  billingRemedy: 'check account credits, payment status and monthly limits at app.fireworks.ai/account/billing, then retry.',
  requestUrl: () => fireworksChatCompletionsUrl(),
  wireModelId: fireworksWireId,
  buildExtras: buildFireworksExtras,
  extraHeaders: () => ({ 'x-session-affinity': getSessionId() }),
  keepsReasoningHistory: () => true,
  streamTransport: options => ({ events: streamCompatChat({ ...options, onResponseHeaders: (headers, status) => fireworksRecordHeaders(headers, status, options.apiKey, options.url) }) }),
}

export function fireworksLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('fireworks')
}

export async function* fireworksCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const verdict = canonicalWireModelId(params.options.model)
  if (!isFireworksModelId(params.options.model) || !verdict.ok || !isFireworksTextModelId(verdict.wireId)) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${!verdict.ok ? verdict.reason : 'Fireworks requires a text model qualified as fireworks/<id>; /model lists the available text models.'}`, error: 'invalid_request' })
    return
  }
  if (!resolveFireworksApiKey()) { yield* compatChatCallModel(fireworksLaneProfile, params); return }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => { onAbort = resolve; params.signal.addEventListener('abort', onAbort, { once: true }) })
  try { await Promise.race([readCatalogueIfPending('fireworks'), cancelled]) }
  finally { params.signal.removeEventListener('abort', onAbort) }
  if (params.signal.aborted) return
  const snapshot = getCachedFireworksCatalogue()
  const listed = fireworksListedModel(snapshot, verdict.wireId)
  const refused = snapshot?.lastError?.includes('refused the credential') === true
  const known = snapshot?.models.length ? listed !== undefined : fireworksDisplayPin(verdict.wireId) !== undefined
  if (refused || !known) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refused ? `${snapshot!.lastError} — /logins fireworks replaces the key.` : `Fireworks model '${verdict.wireId}' is not on the available text list; /model refreshes it.`}`, error: refused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const wire = listed?.id ?? fireworksDisplayPin(verdict.wireId)!.id
  yield* compatChatCallModel({ ...fireworksLaneProfile, wireModelId: () => wire,
    ...(!snapshot?.models.length ? { leadingNotes: ['Fireworks model list unavailable — using the dated pins; the provider decides account access.'] } : {}),
  }, params)
}
