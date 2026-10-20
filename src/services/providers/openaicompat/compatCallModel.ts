import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { stripCompatModelPrefix } from '../routeLaw.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { compatKeyEnvName, compatModelEndpoint, compatModelRefusal } from './compatAccounts.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { compatResponsesTransport } from './compatResponsesTransport.js'
import { assignLlamacppSlot, invalidateLlamacppTotalSlots, readSelfHostedLiveness, resolveLlamacppTotalSlots } from './compatProbe.js'
import { buildHostedExtras, buildMoonshotExtras } from './compatWire.js'
import { compatModelEfforts } from './compatEffort.js'
import { isKimiK3WireModel } from './kimiReplay.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatLaneProfile,
} from './compatChatCallModel.js'
import {
  compatChatCompletionsUrl,
  resolveCompatApiKey,
} from './compatAccounts.js'
import { buildCompatSlotExtras } from './compatWire.js'

export const compatSlotLaneProfile: CompatLaneProfile = {
  lane: 'openai-compat',
  providerLabel: 'Custom endpoint',
  resolveCredential: () => {
    if (compatChatCompletionsUrl() === undefined) return undefined
    const key = resolveCompatApiKey()
    if (!key && providerKeyCommandFailure('compat:default')) return undefined
    return key ? { apiKey: key.key } : {}
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('compat:default')) return null
    const fresh = recoverProviderKeyCommand('compat:default')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('compat:default')
    return failure ? `the configured ${failure.message} — no credential was sent.` : 'the OpenAI-compatible endpoint slot is not configured — set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY if the endpoint needs one).'
  },
  authRemedy:
    'set MERCURY_COMPAT_API_KEY to the key this endpoint expects; a keyless endpoint needs neither.',
  requestUrl: () => {
    const url = compatChatCompletionsUrl()
    if (url === undefined) {
      throw new Error('compat slot unconfigured — resolveCredential refuses before this point')
    }
    return url
  },
  wireModelId: modelId => stripCompatModelPrefix(modelId),
  buildExtras: buildCompatSlotExtras,
}

export function compatSlotLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('openai-compat')
}

export async function* compatCallModel(params: CallModelParams): CallModelStream {
  let resolved: ReturnType<typeof compatModelEndpoint>
  try { resolved = compatModelEndpoint(params.options.model) } catch (error) {
    yield createAssistantAPIErrorMessage({ content: String(error instanceof Error ? error.message : error), error: 'invalid_request' })
    return
  }
  if (!resolved) {
    yield* compatChatCallModel(compatSlotLaneProfile, params)
    return
  }
  const refusal = compatModelRefusal(params.options.model)
  if (refusal) {
    yield createAssistantAPIErrorMessage({ content: refusal, error: 'invalid_request' })
    return
  }
  const { endpoint, wireId } = resolved
  const dialect = endpoint.dialect ?? 'chat-completions'
  const preservedReasoning = dialect === 'vllm' || dialect === 'sglang' || dialect === 'llamacpp' || ['kimi-k3', 'moonshotai/kimi-k3'].includes(wireId.toLowerCase())
  let observation: ReturnType<typeof captureSignInRequest>
  let totalSlots: number | undefined
  let slotReads = 0
  const profile: CompatLaneProfile = {
    ...compatSlotLaneProfile,
    dialect,
    providerLabel: endpoint.label,
    keepsReasoningHistory: () => preservedReasoning,
    keepsReasoningOnContinuations: () => preservedReasoning,
    ...(endpoint.named ? { authRemedy: `/logins compat/${endpoint.name} replaces this endpoint's key; ${compatKeyEnvName(endpoint.name)} takes precedence when set.` } : {}),
    resolveCredential: async () => {
      const key = resolveCompatApiKey(process.env, endpoint.name)
      if (!key && providerKeyCommandFailure(`compat:${endpoint.name}`)) return undefined
      if (endpoint.named) observation = captureSignInRequest(`compat-${endpoint.name}`, key?.key)
      if (dialect === 'llamacpp') {
        if (slotReads > 0) invalidateLlamacppTotalSlots(endpoint)
        slotReads += 1
        totalSlots = await resolveLlamacppTotalSlots(endpoint, { key: key?.key, signal: params.signal })
      }
      return key ? { apiKey: key.key } : {}
    },
    recoverCredential: async () => {
      if (!configuredProviderKeyCommand(`compat:${endpoint.name}`)) return null
      const fresh = recoverProviderKeyCommand(`compat:${endpoint.name}`)
      return fresh ? { apiKey: fresh } : undefined
    },
    get credentialHint(): string {
      const failure = providerKeyCommandFailure(`compat:${endpoint.name}`)
      return failure ? `the configured ${failure.message} — no credential was sent.` : compatSlotLaneProfile.credentialHint
    },
    requestUrl: () => `${endpoint.baseUrl}/chat/completions`,
    wireModelId: () => wireId,
    ...(endpoint.named || dialect === 'llamacpp'
      ? {
          onResponseHeaders: (_headers: Headers, status?: number) => {
            if (endpoint.named) observeSignInResponse(observation, status)
            if (dialect === 'llamacpp' && status !== undefined && status >= 500) invalidateLlamacppTotalSlots(endpoint)
          },
        }
      : {}),
    ...(dialect !== 'chat-completions' && dialect !== 'responses'
      ? {
          liveness: (pinnedSlot: number | undefined) =>
            readSelfHostedLiveness(endpoint, dialect, pinnedSlot, {
              key: resolveCompatApiKey(process.env, endpoint.name)?.key,
              signal: params.signal,
            }),
        }
      : {}),
    extraHeaders: () => ({ ...endpoint.headers, ...(endpoint.sessionAffinityHeader ? { [endpoint.sessionAffinityHeader]: getSessionId() } : {}) }),
    ...(dialect === 'responses' ? { streamTransport: (options, messages) => compatResponsesTransport(options, messages, `${endpoint.name}:${endpoint.baseUrl}`) } : {}),
    ...(dialect === 'ollama' ? { omitsToolChoice: true } : {}),
    buildExtras: args => {
      if (dialect !== 'responses' && isKimiK3WireModel(wireId)) return { ...buildCompatSlotExtras(args), reasoning_effort: buildMoonshotExtras({ ...args, wireModel: 'kimi-k3', effortValue: args.effortValue ?? 'max' }).reasoning_effort, ...(dialect === 'sglang' ? { chat_template_kwargs: { clear_thinking: false } } : {}) }
      const slotKey = args.conversationKey ?? args.cacheDomainKey
      const idSlot = dialect === 'llamacpp' && totalSlots !== undefined && slotKey ? assignLlamacppSlot(endpoint, slotKey, totalSlots, args.crewmate === true) : undefined
      return buildHostedExtras({ ...args, dialect, vocabulary: compatModelEfforts(params.options.model), ...(idSlot !== undefined ? { idSlot } : {}) })
    },
  }
  const startedAt = performance.now()
  for await (const event of compatChatCallModel(profile, params)) {
    if (endpoint.name.startsWith('box-') && event.type === 'assistant' && !event.isApiErrorMessage && event.message.stop_reason) {
      try {
        const { noteBoxTurn } = await import('../../host/boxService.js')
        noteBoxTurn(endpoint.name, endpoint.baseUrl, wireId, event.message.usage.output_tokens, performance.now() - startedAt)
      } catch {}
    }
    yield event
  }
}
