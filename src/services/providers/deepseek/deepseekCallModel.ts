// ============================================================================
//  providers/deepseek/deepseekCallModel — the DeepSeek lane profile over the
//  shared OpenAI-compatible runtime.
//
//  Wire facts (api-docs.deepseek.com/api/create-chat-completion, fetched
//
//    · POST https://api.deepseek.com/chat/completions, Bearer key;
//    · thinking: { type: 'enabled'|'disabled', reasoning_effort:
//      low|high|max } — thinking is the provider default; Mercury's session
//      thinking config maps onto type, the resolved effort rides inside;
//    · stream_options.include_usage delivers the usage object before [DONE]
//      (prompt_cache_hit_tokens decoded by the shared client);
//    · max_tokens is the output knob (sent only on an explicit override);
//    · finish_reason adds content_filter and insufficient_system_resource
//      (the shared client's typed provider-termination channel).
// ============================================================================
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildDeepseekExtras } from '../openaicompat/compatWire.js'
import { deepseekChatCompletionsUrl, resolveDeepseekApiKey } from './deepseekAccounts.js'

export const deepseekLaneProfile: CompatLaneProfile = {
  lane: 'deepseek',
  providerLabel: 'DeepSeek',
  resolveCredential: () => {
    const key = resolveDeepseekApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint:
    'no DeepSeek API key detected — /logins deepseek stores one; DEEPSEEK_API_KEY works too.',
  // api-docs.deepseek.com/quick_start/error_codes (fetched): 401
  // "Authentication Fails" (wrong key) · 402 "Insufficient Balance".
  authRemedy:
    'set a valid DEEPSEEK_API_KEY, or store a new key via /logins deepseek (platform.deepseek.com issues them).',
  billingRemedy:
    'the DeepSeek balance is exhausted — top up the account, then retry; /model picks another model meanwhile.',
  requestUrl: () => deepseekChatCompletionsUrl(),
  wireModelId: modelId => modelId,
  buildExtras: buildDeepseekExtras,
}

export function deepseekLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('deepseek')
}

/** The provider-aware callModel branch for DeepSeek. */
export async function* deepseekCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(deepseekLaneProfile, params)
}
