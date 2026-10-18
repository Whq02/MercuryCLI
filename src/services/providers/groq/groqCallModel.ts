import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { streamCompatChat, type CompatStreamOptions, type CompatStreamEvent } from '../openaicompat/compatChatClient.js'
import { thinkingOffWireEffort, type LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { groqChatCompletionsUrl, resolveGroqApiKey } from './groqAccounts.js'
import { getCachedGroqCatalogue, groqListedModel, groqOutputMaxFor } from './groqCatalogue.js'
import { groqDisplayPin, groqEffortVocabulary, groqWireId, isGroqModelId, isGroqTextModelId } from './groqPins.js'
import { groqHeaderWaitMs, groqRecordHeaders } from './groqUsageState.js'

export function buildGroqExtras(args: LaneExtrasArgs): Record<string, unknown> {
  const pin = groqDisplayPin(args.wireModel)
  const vocabulary = groqEffortVocabulary(args.wireModel)
  const effort = !args.thinkingEnabled ? thinkingOffWireEffort(vocabulary)
    : args.effortValue !== undefined && vocabulary.length > 0 ? nearestSupportedWireEffort(args.effortValue, vocabulary) : undefined
  const output = args.maxOutputTokensOverride ?? groqOutputMaxFor(args.wireModel)
  return {
    stream_options: { include_usage: true },
    ...(pin?.reasoning === 'included' ? { include_reasoning: true } : pin?.reasoning === 'parsed' ? { reasoning_format: 'parsed' } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(output !== undefined ? { max_completion_tokens: output } : {}),
  }
}

async function* groqEvents(options: CompatStreamOptions): AsyncGenerator<CompatStreamEvent> {
  let headers = new Headers()
  const base = options.url.replace(/\/chat\/completions$/, '')
  for await (const event of streamCompatChat({ ...options, onResponseHeaders: (value, status) => {
    headers = value
    if (options.apiKey) groqRecordHeaders(value, options.apiKey, base)
    options.onResponseHeaders?.(value, status)
  } })) {
    if (event.type !== 'stream-fault') { yield event; continue }
    const fault = event.fault
    if (fault.code === 'api-blocked_api_access') {
      yield { ...event, fault: { ...fault, code: 'api-billing-blocked_api_access', retryable: false } }
    } else if (fault.status === 429 && fault.retryAfterMs === undefined) {
      const retryAfterMs = groqHeaderWaitMs(headers)
      yield { ...event, fault: { ...fault, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }
    } else yield event
  }
}

const groqLaneProfile: CompatLaneProfile = {
  lane: 'groq', providerLabel: 'Groq',
  resolveCredential: () => {
    const key = resolveGroqApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint: 'no Groq API key detected — /logins groq stores one from console.groq.com/keys; GROQ_API_KEY works too.',
  authRemedy: 'create a current key at console.groq.com/keys and store it with /logins groq, or set GROQ_API_KEY.',
  billingRemedy: 'the organization spend limit is reached — check console.groq.com/settings/billing/limits, then retry.',
  requestUrl: () => groqChatCompletionsUrl(),
  wireModelId: groqWireId,
  buildExtras: buildGroqExtras,
  streamTransport: options => ({ events: groqEvents(options) }),
  policyFaultNote: fault => fault.status === 429 ? ' Groq Free-tier token limits can be too small for tool-bearing turns; the Developer tier offers higher limits.' : undefined,
}

export function groqLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('groq')
}

export async function* groqCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const verdict = canonicalWireModelId(params.options.model)
  if (!isGroqModelId(params.options.model) || !verdict.ok || !isGroqTextModelId(verdict.wireId)) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${!verdict.ok ? verdict.reason : 'Groq requires a text model qualified as groq/<id>; /model lists the available text models.'}`, error: 'invalid_request' })
    return
  }
  if (!resolveGroqApiKey()) { yield* compatChatCallModel(groqLaneProfile, params); return }
  let onAbort: () => void = () => {}
  const cancelled = new Promise<void>(resolve => { onAbort = resolve; params.signal.addEventListener('abort', onAbort, { once: true }) })
  try { await Promise.race([readCatalogueIfPending('groq'), cancelled]) }
  finally { params.signal.removeEventListener('abort', onAbort) }
  if (params.signal.aborted) return
  const snapshot = getCachedGroqCatalogue()
  const listed = groqListedModel(snapshot, verdict.wireId)
  const refused = snapshot?.lastError?.includes('refused the credential') === true
  const known = snapshot?.models.length ? listed !== undefined : groqDisplayPin(verdict.wireId) !== undefined
  if (refused || !known) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${refused ? `${snapshot!.lastError} — /logins groq replaces the key.` : `Groq model '${verdict.wireId}' is not on the available text list; /model refreshes it.`}`, error: refused ? 'authentication_failed' : 'invalid_request' })
    return
  }
  const wire = listed?.id ?? groqDisplayPin(verdict.wireId)!.id
  yield* compatChatCallModel({ ...groqLaneProfile, wireModelId: () => wire,
    ...(!snapshot?.models.length ? { leadingNotes: ['Groq model list unavailable — using the dated pins; the provider decides account access.'] } : {}),
  }, params)
}
