import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { createHash } from 'node:crypto'
import { streamCompatChat } from '../openaicompat/compatChatClient.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { thinkingOffWireEffort, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { cerebrasChatCompletionsUrl, resolveCerebrasApiKey } from './cerebrasAccounts.js'
import { getCachedCerebrasCatalogue, cerebrasListedModel } from './cerebrasCatalogue.js'
import { cerebrasDisplayPin, cerebrasEffortVocabulary, cerebrasWireId, isCerebrasModelId, isCerebrasTextModelId } from './cerebrasPins.js'
import { cerebrasRecordHeaders } from './cerebrasUsageState.js'

export function buildCerebrasExtras(args: LaneExtrasArgs, cacheKey: string = getSessionId()): Record<string, unknown> {
  const vocabulary = cerebrasEffortVocabulary(args.wireModel)
  const effort = !args.thinkingEnabled ? thinkingOffWireEffort(vocabulary)
    : args.effortValue !== undefined && vocabulary.length > 0 ? nearestSupportedWireEffort(args.effortValue, vocabulary) : undefined
  return { stream_options: { include_usage: true }, prompt_cache_key: cacheKey, ...(effort !== undefined ? { reasoning_effort: effort } : {}) }
}

const cerebrasLaneProfile: CompatLaneProfile = {
  lane: 'cerebras', providerLabel: 'Cerebras',
  resolveCredential: () => {
    const key = resolveCerebrasApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('cerebras')) return null
    const fresh = recoverProviderKeyCommand('cerebras')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('cerebras')
    return failure ? `the configured ${failure.message} — no Cerebras API key detected.` : 'no Cerebras API key detected — /logins cerebras stores one from cloud.cerebras.ai; CEREBRAS_API_KEY works too.'
  },
  authRemedy: 'create a current key at cloud.cerebras.ai and store it with /logins cerebras, or set CEREBRAS_API_KEY.',
  billingRemedy: 'the account credits are spent or the trial expired — check cloud.cerebras.ai, then retry.',
  requestUrl: () => cerebrasChatCompletionsUrl(),
  wireModelId: cerebrasWireId,
  buildExtras: buildCerebrasExtras,
  streamTransport: options => ({ events: streamCompatChat({ ...options, onResponseHeaders: (headers, status) => cerebrasRecordHeaders(headers, status, options.apiKey, options.url) }) }),
}

export function cerebrasLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('cerebras')
}

export async function* cerebrasCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const verdict = canonicalWireModelId(params.options.model)
  if (!isCerebrasModelId(params.options.model) || !verdict.ok || !isCerebrasTextModelId(verdict.wireId)) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${!verdict.ok ? verdict.reason : 'Cerebras requires a text model qualified as cerebras/<id>; /model lists the available text models.'}`, error: 'invalid_request' })
    return
  }
  if (!resolveCerebrasApiKey()) { yield* compatChatCallModel(cerebrasLaneProfile, params); return }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => { onAbort = resolve; params.signal.addEventListener('abort', onAbort, { once: true }) })
  try { await Promise.race([readCatalogueIfPending('cerebras'), cancelled]) }
  finally { params.signal.removeEventListener('abort', onAbort) }
  if (params.signal.aborted) return
  const snapshot = getCachedCerebrasCatalogue()
  const listed = cerebrasListedModel(snapshot, verdict.wireId)
  const refused = snapshot?.lastError?.includes('refused the credential') === true
  const known = snapshot?.models.length ? listed !== undefined : cerebrasDisplayPin(verdict.wireId) !== undefined
  if (refused || !known) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refused ? `${snapshot!.lastError} — /logins cerebras replaces the key.` : `Cerebras model '${verdict.wireId}' is not on the available text list; /model refreshes it.`}`, error: refused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const wire = listed?.id ?? cerebrasDisplayPin(verdict.wireId)!.id
  const cacheKey = createHash('sha256').update(JSON.stringify([getSessionId(), params.options.ownerKey ?? params.options.agentId ?? 'main', wire])).digest('hex')
  yield* compatChatCallModel({ ...cerebrasLaneProfile, wireModelId: () => wire, buildExtras: args => buildCerebrasExtras(args, cacheKey),
    ...(!snapshot?.models.length ? { leadingNotes: ['Cerebras model list unavailable — using the dated pins; the provider decides account access.'] } : {}),
  }, params)
}
