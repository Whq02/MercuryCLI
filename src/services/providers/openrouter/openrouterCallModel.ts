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
import { getProductUserAgent } from '../../../utils/http.js'
import { buildOpenrouterExtras } from '../openaicompat/compatWire.js'
import { qualifiedWireId } from '../routeLaw.js'
import { getCachedOpenrouterCatalogue, openrouterEffortVocabularyFor, refreshOpenrouterCatalogue } from './openrouterCatalogue.js'
import {
  openrouterApiBase,
  resolveOpenrouterAccount,
  resolveOpenrouterApiKey,
  resolveOpenrouterRequestAuth,
} from './openrouterAccounts.js'
import {
  recordOpenrouterRateHeaders,
  refreshOpenrouterKeyUsage,
} from './openrouterUsageState.js'

export function openrouterWireModelId(modelId: string): string {
  const slug = qualifiedWireId(modelId)
  const auth = resolveOpenrouterRequestAuth()
  const snapshot = auth ? getCachedOpenrouterCatalogue(auth.account.keySource) : null
  if (!snapshot || snapshot.models.length === 0) return slug
  const listed = new Map(snapshot.models.map(m => [m.id.toLowerCase(), m.id]))
  const hit = (candidate: string): string | undefined => listed.get(candidate.trim().toLowerCase())
  const direct = hit(slug)
  if (direct !== undefined) return direct
  const CONTEXT_TAG_RE = /\[(?:[0-9]+m|served)\]$/i
  const untagged = slug.replace(CONTEXT_TAG_RE, '')
  const segments = slug.split('/')
  const devendored = segments.length >= 3 ? segments.slice(1).join('/') : undefined
  for (const candidate of [
    untagged !== slug ? untagged : undefined,
    devendored,
    devendored !== undefined ? devendored.replace(CONTEXT_TAG_RE, '') : undefined,
  ]) {
    if (candidate === undefined || candidate === slug) continue
    const found = hit(candidate)
    if (found !== undefined) return found
  }
  return slug
}

export const openrouterLaneProfile: CompatLaneProfile = {
  lane: 'openrouter',
  providerLabel: 'OpenRouter',
  resolveCredential: () => {
    const key = resolveOpenrouterApiKey()
    return key ? { apiKey: key.key } : undefined
  },
  credentialHint:
    'no OpenRouter credential detected — /logins connects OpenRouter (OAuth mints a key), or set OPENROUTER_API_KEY.',
  authRemedy:
    '/logins reconnects OpenRouter (the OAuth flow mints a fresh key), or set a valid OPENROUTER_API_KEY.',
  billingRemedy:
    'the OpenRouter account has insufficient credits — add credits, then retry; /model picks another model meanwhile.',
  requestUrl: () => `${openrouterApiBase()}/chat/completions`,
  wireModelId: modelId => openrouterWireModelId(modelId),
  buildExtras: args =>
    buildOpenrouterExtras({
      ...args,
      vocabulary: openrouterEffortVocabularyFor(`openrouter/${args.wireModel}`),
    }),
  extraHeaders: () => ({ 'user-agent': getProductUserAgent() }),
  onResponseHeaders: headers => {
    recordOpenrouterRateHeaders(headers)
    void refreshOpenrouterKeyUsage().catch(() => {})
    const account = resolveOpenrouterAccount()
    if (account) void refreshOpenrouterCatalogue(account.keySource).catch(() => {})
  },
}

export function openrouterLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('openrouter')
}

export async function* openrouterCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(openrouterLaneProfile, params)
}
