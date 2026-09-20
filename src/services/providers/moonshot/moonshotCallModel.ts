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
import { qualifyMoonshotModel } from './moonshotCatalogue.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
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
  recoverCredential: async () => {
    if (moonshotDispatchSource() !== 'kimi-oauth') return null
    const fresh = await refreshMoonshotTokens()
    if (!fresh) return undefined
    return resolveMoonshotDispatchCredential()
  },
  requestUrl: () => moonshotChatCompletionsUrl(),
  wireModelId: modelId => modelId,
  onResponseHeaders: () => {
    if (moonshotDispatchSource() === 'kimi-oauth') void refreshKimiManagedUsage()
  },
  buildExtras: buildMoonshotExtras,
  keepsReasoningHistory: wireModel => KIMI_PRESERVED_THINKING_MODELS.has(wireModel),
}

export function moonshotLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('moonshot')
}

export async function* moonshotCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  if (params.signal.aborted) return
  if (moonshotDispatchSource() !== undefined) {
    let onAbort: () => void = () => {}
    const cancelled = new Promise<null>(resolve => {
      onAbort = () => resolve(null)
      params.signal.addEventListener('abort', onAbort, { once: true })
    })
    let qualification: Awaited<ReturnType<typeof qualifyMoonshotModel>> | null
    try {
      qualification = await Promise.race([qualifyMoonshotModel(normalizeModelStringForAPI(params.options.model)), cancelled])
    } finally {
      params.signal.removeEventListener('abort', onAbort)
    }
    if (qualification === null || params.signal.aborted) return
    if (qualification.kind === 'refused') {
      yield createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${qualification.message}` })
      return
    }
    if (qualification.kind === 'degraded') {
      yield* compatChatCallModel({ ...moonshotLaneProfile, leadingNotes: [qualification.note] }, params)
      return
    }
  }
  yield* compatChatCallModel(moonshotLaneProfile, params)
}
