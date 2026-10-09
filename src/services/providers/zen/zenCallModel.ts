import type { AssistantMessage, StreamEvent, SystemAPIErrorMessage } from '../../../types/message.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatCallModelParams, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { buildXaiExtras, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { KIMI_PRESERVED_THINKING_MODELS } from '../moonshot/kimiPins.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { resolveZenAccount, resolveZenApiKey, zenChatCompletionsUrl, zenRequestHeaders, ZEN_ENV_KEY, ZEN_KEY_PAGE } from './zenAccounts.js'
import { cachedLiveIds, getCachedZenCatalogue, refreshZenCatalogue } from './zenCatalogue.js'
import { zenDisplayPin, zenWireId, zenWireShapeOf } from './zenPins.js'
import { zenResponsesTransport } from './zenResponsesTransport.js'

export function buildZenExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const pin = zenDisplayPin(args.wireModel)
  const extras = buildXaiExtras({ ...args, vocabulary: pin?.efforts ?? [] })
  return pin?.thinkingToggle === true ? { ...extras, thinking: { type: args.thinkingEnabled ? 'enabled' : 'disabled' } } : extras
}

export const zenLaneProfile: CompatLaneProfile = {
  lane: 'zen',
  providerLabel: 'OpenCode Zen',
  resolveCredential: () => {
    const key = resolveZenApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint: `no OpenCode Zen API key detected — /logins zen stores one (made at ${ZEN_KEY_PAGE}); ${ZEN_ENV_KEY} works too.`,
  authRemedy: `create a key at ${ZEN_KEY_PAGE} and store it with /logins zen, or set a valid ${ZEN_ENV_KEY}.`,
  billingRemedy: 'the Zen balance is empty or a monthly limit is reached — add credits or raise the limit in the OpenCode console (opencode.ai/auth → Billing), then retry; /model picks another model meanwhile.',
  requestUrl: () => zenChatCompletionsUrl(),
  wireModelId: model => zenWireId(model),
  extraHeaders: () => zenRequestHeaders(getProductUserAgent(), getSessionId()),
  toolCapabilityRefusal: model => zenDisplayPin(model)?.tools === false ? `OpenCode Zen model '${zenWireId(model)}' does not support tool calls.` : undefined,
  keepsReasoningHistory: wireModel => KIMI_PRESERVED_THINKING_MODELS.has(wireModel),
  buildExtras: buildZenExtras,
  onResponseHeaders: (_headers, status) => {
    if (status === undefined || status < 200 || status >= 300) return
    void refreshProviderUsage('zen', { reason: 'operator' }).catch(() => {})
    void refreshZenCatalogue().catch(() => {})
  },
}

export function zenLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('zen')
}

export async function* zenCallModel(params: CompatCallModelParams): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  if (params.signal.aborted) return
  const account = resolveZenAccount()
  if (!account) {
    yield* compatChatCallModel(zenLaneProfile, params)
    return
  }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => {
    onAbort = resolve
    params.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([readCatalogueIfPending('zen'), cancelled])
  } finally {
    params.signal.removeEventListener('abort', onAbort)
  }
  if (params.signal.aborted) return
  const snapshot = getCachedZenCatalogue()
  const wire = zenWireId(params.options.model)
  let refusal: string | undefined
  const credentialRefused = snapshot?.lastError?.includes('refused the credential') === true
  if (credentialRefused) refusal = `${snapshot!.lastError} — /logins zen replaces the key.`
  else if (wire === '') refusal = `'${params.options.model.trim()}' names no model inside the zen/ namespace — /model lists the live Zen rows.`
  else if (snapshot && snapshot.fetchedAtMs > 0 && !cachedLiveIds().has(wire.toLowerCase())) {
    refusal = modelNotOfferedByCatalogue(wire, account.label, [...cachedLiveIds()])
  }
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`, error: credentialRefused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const notes = snapshot?.lastError || !snapshot?.fetchedAtMs ? [`OpenCode Zen model list unavailable — the named id '${wire}' is sent for the gateway to decide.`] : undefined
  const shape = zenWireShapeOf(wire) ?? 'chat'
  yield* compatChatCallModel({
    ...zenLaneProfile,
    ...(notes ? { leadingNotes: notes } : {}),
    ...(shape === 'responses' ? { streamTransport: zenResponsesTransport } : {}),
    wireModelId: () => wire,
  }, params)
}
