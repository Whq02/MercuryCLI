// ============================================================================
//  providers/openaicompat/compatCallModel — the operator-named compat slot's
//  lane profile over the shared runtime.
//
//  The baseline OpenAI-compatible dialect, no vendor-specific knobs:
//    · model ids arrive as compat/<vendor-id> and the prefix is stripped at
//      the wire;
//    · a keyless dispatch is LEGAL (local servers) — the refusal is only for
//      an UNCONFIGURED slot (no base URL);
//    · stream_options.include_usage (the OpenAI-compat standard) asks for
//      the usage object before [DONE]; max_tokens only on an explicit
//      override; no effort/thinking knobs are sent (no documented vocabulary
//      to verify against — the provider default governs).
// ============================================================================
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { stripCompatModelPrefix } from '../routeLaw.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatCallModelParams,
  type CompatLaneProfile,
} from './compatChatCallModel.js'
import {
  compatChatCompletionsUrl,
  resolveCompatApiKey,
  resolveCompatSlotConfig,
} from './compatAccounts.js'
import { buildCompatSlotExtras } from './compatWire.js'

// No module-load config read (the no-load-side-effects law): the static
// profile carries the neutral label; compatCallModel re-resolves the
// operator's label per call below.
export const compatSlotLaneProfile: CompatLaneProfile = {
  lane: 'openai-compat',
  providerLabel: 'Custom endpoint',
  resolveCredential: () => {
    if (compatChatCompletionsUrl() === undefined) return undefined
    const key = resolveCompatApiKey()
    return key ? { apiKey: key.key } : {}
  },
  credentialHint:
    'the OpenAI-compatible endpoint slot is not configured — set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY / /router key compat if the endpoint needs one).',
  authRemedy:
    'set MERCURY_COMPAT_API_KEY (or /router key compat) to the key this endpoint expects; a keyless endpoint needs neither.',
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

/** The provider-aware callModel branch for the compat slot. The label is
 *  re-resolved per call (config can change between sessions). */
export async function* compatCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const label = resolveCompatSlotConfig()?.label
  const profile: CompatLaneProfile =
    label !== undefined && label !== compatSlotLaneProfile.providerLabel
      ? { ...compatSlotLaneProfile, providerLabel: label }
      : compatSlotLaneProfile
  yield* compatChatCallModel(profile, params)
}
