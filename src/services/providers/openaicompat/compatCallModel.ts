import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { stripCompatModelPrefix } from '../routeLaw.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { compatKeyEnvName, compatModelEndpoint, compatModelRefusal } from './compatAccounts.js'
import { compatResponsesTransport } from './compatResponsesTransport.js'
import { buildLocalExtras } from './compatWire.js'
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
    return key ? { apiKey: key.key } : {}
  },
  credentialHint:
    'the OpenAI-compatible endpoint slot is not configured — set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY if the endpoint needs one).',
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
  let observation: ReturnType<typeof captureSignInRequest>
  const profile: CompatLaneProfile = {
    ...compatSlotLaneProfile,
    providerLabel: endpoint.label,
    ...(endpoint.named ? { authRemedy: `/logins compat/${endpoint.name} replaces this endpoint's key; ${compatKeyEnvName(endpoint.name)} takes precedence when set.` } : {}),
    resolveCredential: () => {
      const key = resolveCompatApiKey(process.env, endpoint.name)
      if (endpoint.named) observation = captureSignInRequest(`compat-${endpoint.name}`, key?.key)
      return key ? { apiKey: key.key } : {}
    },
    requestUrl: () => `${endpoint.baseUrl}/chat/completions`,
    wireModelId: () => wireId,
    ...(endpoint.named ? { onResponseHeaders: (_headers: Headers, status?: number) => observeSignInResponse(observation, status) } : {}),
    extraHeaders: () => ({ ...endpoint.headers, ...(endpoint.sessionAffinityHeader ? { [endpoint.sessionAffinityHeader]: getSessionId() } : {}) }),
    ...(dialect === 'responses' ? { streamTransport: (options, messages) => compatResponsesTransport(options, messages, `${endpoint.name}:${endpoint.baseUrl}`) } : {}),
    ...(dialect === 'ollama' ? { omitsToolChoice: true } : {}),
    buildExtras: args => dialect === 'chat-completions' || dialect === 'responses'
      ? buildCompatSlotExtras(args)
      : buildLocalExtras({ ...args, server: dialect, acceptsEffort: true }),
  }
  yield* compatChatCallModel(profile, params)
}
