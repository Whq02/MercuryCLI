import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { readCatalogueIfPending } from '../catalogueOnDemand.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { compatChatCallModel, compatLaneLiveProofState, type CompatLaneProfile } from '../openaicompat/compatChatCallModel.js'
import { streamCompatChat, type CompatStreamOptions, type CompatStreamEvent, type CompatFault } from '../openaicompat/compatChatClient.js'
import type { LaneExtrasArgs } from '../openaicompat/compatWire.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { meliousChatCompletionsUrl, resolveMeliousApiKey } from './meliousAccounts.js'
import { getCachedMeliousCatalogue, isMeliousModelId, meliousListedModel, meliousWireId } from './meliousCatalogue.js'
import { meliousRecordChunk, meliousRecordHeaders } from './meliousUsageState.js'

export function buildMeliousExtras(args: LaneExtrasArgs): Record<string, unknown> {
  return {
    stream_options: { include_usage: true },
    ...(!args.thinkingEnabled ? { reasoning_effort: 'none' } : args.effortValue !== undefined ? { reasoning_effort: args.effortValue } : {}),
    ...(args.maxOutputTokensOverride !== undefined ? { max_tokens: args.maxOutputTokensOverride } : {}),
  }
}

export async function* streamMeliousChat(options: CompatStreamOptions): AsyncGenerator<CompatStreamEvent> {
  const base = options.url.replace(/\/chat\/completions$/, '')
  let output = false
  let failed = false
  let finish: Extract<CompatStreamEvent, { type: 'finish' }> | undefined
  for await (const event of streamCompatChat({ ...options, requireDone: true,
    onResponseHeaders: (headers, status) => {
      if (options.apiKey) meliousRecordHeaders(headers, options.apiKey, base)
      options.onResponseHeaders?.(headers, status)
    },
    onResponseChunk: chunk => {
      if (options.apiKey) meliousRecordChunk(chunk, options.apiKey, base)
      options.onResponseChunk?.(chunk)
    },
  })) {
    if (event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-call-fragment') output = true
    if (event.type === 'finish') {
      if (event.rawReason === 'blocked') {
        failed = true
        yield { type: 'stream-fault', fault: { kind: 'provider-termination', code: 'finish:blocked', message: 'Melious AI ended this response: blocked', retryable: false } }
      } else finish = event.rawReason === 'blueprint_override' ? { ...event, reason: 'stop' } : event
      continue
    }
    if (event.type === 'usage') {
      const { statedCostUSD: _foreignCost, ...usage } = event.usage
      yield { type: 'usage', usage }
      continue
    }
    if (event.type !== 'stream-fault') { yield event; continue }
    failed = true
    let fault: CompatFault = event.fault
    const hold = fault.code === 'api-billing_hold_creation_failed'
    if (hold) fault = { ...fault, classification: 'server_error', retryable: true }
    else if (fault.errorType === 'billing_error') fault = { ...fault, classification: 'billing_error', retryable: false }
    else if (fault.errorType === 'rate_limit_exceeded') fault = { ...fault, classification: 'rate_limit', retryable: true }
    else if (fault.errorType === 'server_error') fault = { ...fault, classification: 'server_error', retryable: true }
    if (output && fault.kind !== 'cancelled') fault = { ...fault, kind: 'api-error', retryable: false, inStream: undefined }
    yield { type: 'stream-fault', fault }
  }
  if (!failed && finish) yield finish
}

const meliousLaneProfile: CompatLaneProfile = {
  lane: 'melious', providerLabel: 'Melious AI',
  partialFaultPolicy: 'stop',
  resolveCredential: () => {
    const key = resolveMeliousApiKey()
    return key ? { apiKey: key.key, requestUrl: meliousChatCompletionsUrl() } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('melious')) return null
    const fresh = recoverProviderKeyCommand('melious')
    return fresh ? { apiKey: fresh, requestUrl: meliousChatCompletionsUrl() } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('melious')
    return failure ? `the configured ${failure.message} — no Melious AI API key detected.` : 'no Melious AI API key detected — /logins melious stores one from melious.ai/account/api/keys; MELIOUS_API_KEY works too.'
  },
  authRemedy: 'create a key with inference.models and inference.chat at melious.ai/account/api/keys and store it with /logins melious, or set MELIOUS_API_KEY.',
  billingRemedy: 'check melious.ai/account/billing, then retry.',
  requestUrl: () => meliousChatCompletionsUrl(),
  wireModelId: meliousWireId,
  buildExtras: buildMeliousExtras,
  streamTransport: options => ({ events: streamMeliousChat(options) }),
}

export function meliousLiveProofState(): { at: number; model: string } | null { return compatLaneLiveProofState('melious') }

export async function* meliousCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  const verdict = canonicalWireModelId(params.options.model)
  if (!isMeliousModelId(params.options.model) || !verdict.ok) {
    yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${!verdict.ok ? verdict.reason : 'Melious AI requires a model qualified as melious/<id>; /model lists the available models.'}`, error: 'invalid_request' })
    return
  }
  if (resolveMeliousApiKey()) {
    let onAbort: () => void = () => {}
    const cancelled = new Promise<void>(resolve => { onAbort = resolve; params.signal.addEventListener('abort', onAbort, { once: true }) })
    try { await Promise.race([readCatalogueIfPending('melious'), cancelled]) }
    finally { params.signal.removeEventListener('abort', onAbort) }
    if (params.signal.aborted) return
    const snapshot = getCachedMeliousCatalogue()
    if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.lastError && !meliousListedModel(verdict.wireId)) {
      yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: Melious AI model '${verdict.wireId}' is not on the available chat list; /model refreshes it.`, error: 'invalid_request' })
      return
    }
  }
  yield* compatChatCallModel(meliousLaneProfile, params)
}
