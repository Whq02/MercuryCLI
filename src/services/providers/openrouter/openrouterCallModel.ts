import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { buildOpenrouterExtras } from '../openaicompat/compatWire.js'
import { qualifiedWireId } from '../routeLaw.js'
import { getCachedOpenrouterCatalogue, openrouterEffortVocabularyFor, refreshOpenrouterCatalogue } from './openrouterCatalogue.js'
import {
  OPENROUTER_AUTH_REMEDY,
  clearOpenrouterKeyRefusal,
  markOpenrouterKeyRefused,
  openrouterApiBase,
  resolveOpenrouterAccount,
  resolveOpenrouterApiKey,
  resolveOpenrouterRequestAuth,
} from './openrouterAccounts.js'
import {
  clearOpenrouterUsageLimit,
  openrouterLimitWindow,
  recordOpenrouterRateHeaders,
  refreshOpenrouterKeyUsage,
} from './openrouterUsageState.js'
import { openrouterResponsesTransport } from './openrouterResponsesTransport.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import { openrouterProviderObject } from './openrouterRoutingPolicy.js'

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
  authRemedy: OPENROUTER_AUTH_REMEDY,
  billingRemedy:
    'the OpenRouter account has insufficient credits — add credits, then retry; /model picks another model meanwhile.',
  requestUrl: () => `${openrouterApiBase()}/chat/completions`,
  wireModelId: modelId => openrouterWireModelId(modelId),
  buildExtras: args =>
    buildOpenrouterExtras({
      ...args,
      vocabulary: openrouterEffortVocabularyFor(`openrouter/${args.wireModel}`),
      providerPolicy: openrouterProviderObject(getInitialSettings().routing?.openrouter),
    }),
  extraHeaders: () => ({ 'user-agent': getProductUserAgent() }),
  streamTransport: (options, messages) => openrouterResponsesTransport(options, messages),
  policyFaultNote: (fault, extra) =>
    fault.status === 503 && /no available (model )?provider/i.test(fault.message) && extra?.provider !== undefined
      ? ' — no OpenRouter endpoint met your routing policy; /config → OpenRouter routing policy widens it'
      : undefined,
  onResponseHeaders: (headers, status) => {
    recordOpenrouterRateHeaders(headers)
    if (status !== undefined && status >= 200 && status < 300) {
      clearOpenrouterUsageLimit()
      clearOpenrouterKeyRefusal(resolveOpenrouterApiKey())
    }
    void refreshOpenrouterKeyUsage({ force: status === 429 }).catch(() => {})
    const account = resolveOpenrouterAccount()
    if (account) void refreshOpenrouterCatalogue(account.keySource).catch(() => {})
  },
  onCredentialRefused: fault => {
    const key = resolveOpenrouterApiKey()
    if (key !== undefined && fault.status !== undefined) markOpenrouterKeyRefused(key, fault.status, fault.message)
  },
}

export function openrouterLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('openrouter')
}

export async function* openrouterCallModel(params: CallModelParams): CallModelStream {
  if (openrouterLimitWindow().state === 'limited') await refreshProviderUsage('openrouter', { force: true, reason: 'operator' })
  yield* compatChatCallModel(openrouterLaneProfile, params)
}
