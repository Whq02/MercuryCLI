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
