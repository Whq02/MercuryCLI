// ============================================================================
//  providers/moonshot/moonshotCallModel — the Moonshot/Kimi lane profile over
//  the shared OpenAI-compatible runtime.
//
//  Wire facts:
//    · POST {base}/chat/completions, Bearer credential — the base is the
//      credential's own: the platform base for an API key, the region's
//      coding base for a Kimi sign-in (moonshotAccounts resolves both as ONE
//      record, so the bearer and the host it is valid on never split);
//    · reasoning_content deltas; reasoning_effort low|high|max on kimi-k3
//      (always-on reasoning there);
//    · kimi-k3/k2.x FIX their sampling — temperature is documented only for
//      the legacy moonshot-v1-* family, so this lane never sends it;
//    · the output knob is max_completion_tokens (sent only on an explicit
//      Mercury override — the provider default governs otherwise; no invented
//      ceilings);
//    · usage carries top-level cached_tokens (decoded by the shared client).
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
import { buildMoonshotExtras } from '../openaicompat/compatWire.js'
import { KIMI_PRESERVED_THINKING_MODELS } from './kimiPins.js'
import {
  moonshotChatCompletionsUrl,
  moonshotDispatchSource,
  refreshMoonshotTokens,
  resolveMoonshotDispatchCredential,
} from './moonshotAccounts.js'
import { refreshKimiManagedUsage } from './moonshotUsageState.js'

export const moonshotLaneProfile: CompatLaneProfile = {
  lane: 'moonshot',
  providerLabel: 'Moonshot',
  resolveCredential: () => resolveMoonshotDispatchCredential(),
  credentialHint:
    'no Kimi sign-in or Moonshot API key detected — /logins moonshot signs in with a device code or stores a key; MOONSHOT_API_KEY works too.',
  authRemedy:
    'sign in again at /logins moonshot, or set a valid MOONSHOT_API_KEY / store a new key there (the Moonshot console issues them).',
  billingRemedy:
    'the Moonshot balance is exhausted — top up the account, then retry; /model picks another model meanwhile.',
  // Refresh-on-401: a Kimi sign-in the host rejects earns ONE forced refresh
  // and a retry on the fresh bearer; a key cannot change, so nothing recovers.
  recoverCredential: async () => {
    // A key has no refresh route — null, so the refusal never claims an attempt.
    if (moonshotDispatchSource() !== 'kimi-oauth') return null
    const fresh = await refreshMoonshotTokens()
    if (!fresh) return undefined
    return resolveMoonshotDispatchCredential()
  },
  requestUrl: () => moonshotChatCompletionsUrl(),
  wireModelId: modelId => modelId,
  // A settled response on the Kimi sign-in re-reads the managed usage meter
  // (TTL-bounded, never throws) so the rail and the Usage tab stay live.
  onResponseHeaders: () => {
    if (moonshotDispatchSource() === 'kimi-oauth') void refreshKimiManagedUsage()
  },
  buildExtras: buildMoonshotExtras,
  // Preserved Thinking (always-on models only): the docs REQUIRE historical
  // reasoning_content returned as-is; k2.6's opt-in default stays omit.
  keepsReasoningHistory: wireModel => KIMI_PRESERVED_THINKING_MODELS.has(wireModel),
}

export function moonshotLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('moonshot')
}

/** The provider-aware callModel branch for Moonshot/Kimi. */
export async function* moonshotCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(moonshotLaneProfile, params)
}
