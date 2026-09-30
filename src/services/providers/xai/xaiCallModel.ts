export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type {
  CompatCallModelParams,
  CompatLaneId,
  CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { xaiChatCompletionsUrl } from './xaiAccounts.js'
import { xaiCurrentModelId } from './xaiPins.js'

export const xaiLaneProfile: CompatLaneProfile = {
  lane: 'xai' as CompatLaneId,
  providerLabel: 'xAI',
  resolveCredential: () => undefined,
  credentialHint: 'no xAI API key detected — /logins xai stores one; XAI_API_KEY works too.',
  requestUrl: () => xaiChatCompletionsUrl(),
  wireModelId: modelId => xaiCurrentModelId(modelId),
  buildExtras: () => ({}),
}

export function xaiLiveProofState(): { at: number; model: string } | null {
  return null
}

export async function* xaiCallModel(
  _params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  return
}
