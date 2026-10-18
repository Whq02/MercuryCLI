import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildDeepseekExtras } from '../openaicompat/compatWire.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { deepseekChatCompletionsUrl, resolveDeepseekApiKey } from './deepseekAccounts.js'
import { deepseekCurrentModelId } from './deepseekPins.js'

export const deepseekLaneProfile: CompatLaneProfile = {
  lane: 'deepseek',
  providerLabel: 'DeepSeek',
  resolveCredential: () => {
    const key = resolveDeepseekApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('deepseek')) return null
    const fresh = recoverProviderKeyCommand('deepseek')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('deepseek')
    return failure ? `the configured ${failure.message} — no DeepSeek API key detected.` : 'no DeepSeek API key detected — /logins deepseek stores one; DEEPSEEK_API_KEY works too.'
  },
  authRemedy:
    'set a valid DEEPSEEK_API_KEY, or store a new key via /logins deepseek (platform.deepseek.com issues them).',
  billingRemedy:
    'the DeepSeek balance is exhausted — top up the account, then retry; /model picks another model meanwhile.',
  requestUrl: () => deepseekChatCompletionsUrl(),
  wireModelId: modelId => deepseekCurrentModelId(modelId),
  buildExtras: buildDeepseekExtras,
}

export function deepseekLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('deepseek')
}

export async function* deepseekCallModel(params: CallModelParams): CallModelStream {
  yield* compatChatCallModel(deepseekLaneProfile, params)
}
