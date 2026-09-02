// ============================================================================
//  providers/openrouter/openrouterCallModel — the OpenRouter dispatch runtime
//
//
//  A thin CompatLaneProfile over the shared chat-completions runtime: bearer
//  auth from the lane's own resolver (env > OAuth-minted > stored, never read
//  here), the vendor-slug wire id recovered by stripping the persisted
//  'openrouter/' namespace (routeLaw.qualifiedWireId — persisted ids stay
//  provider-qualified, the wire sees the vendor's own slug), and the response
//  seam folding rate headers + kicking the polled key-usage refresh so the
//  usage owner stays live without a second transport.
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

/**
 * The wire id for an openrouter-routed model, adjudicated against the LIVE
 * catalogue. The namespace strips first (routeLaw); then, when a fetched
 * catalogue exists and the slug is NOT listed, two Mercury-side dressings
 * are peeled — each accepted only when the peeled spelling IS listed:
 *   · a trailing context tag ('[1m]'/'[2m]'/'[served]') — Mercury display
 *     annotations that a persisted id can carry into the wire position
 *     (live 400: '…gpt-5.6-terra[1m] is not a valid model ID'). The real
 *     catalogue serves NO bracket ids; a bracket spelling reaches here only
 *     as Mercury dressing or from an agent-compatibility model view, and a
 *     catalogue-listed spelling always passes verbatim above;
 *   · one spurious leading vendor segment ('anthropic/' prepended onto an
 *     already-carrier-shaped 'openai/gpt-5.6-terra…' — the shape an
 *     agent-compatibility view lists and older persistence may still hand
 *     this build).
 * No catalogue (unfetched/empty) or no listed peeling ⇒ the slug passes
 * through unchanged — adjudication never guesses.
 */
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
  // A minted key has no refresh route (the PKCE exchange mints once), so a
  // rejected credential is re-minted by /logins, never refreshed here.
  authRemedy:
    '/logins reconnects OpenRouter (the OAuth flow mints a fresh key), or set a valid OPENROUTER_API_KEY.',
  billingRemedy:
    'the OpenRouter account has insufficient credits — add credits, then retry; /model picks another model meanwhile.',
  requestUrl: () => `${openrouterApiBase()}/chat/completions`,
  // Persisted ids are provider-qualified ('openrouter/<vendor-slug>'); the
  // wire receives the vendor's own slug, ADJUDICATED against the live
  // catalogue (openrouterWireModelId) so a Mercury display dressing can
  // never ride where the canonical id belongs.
  wireModelId: modelId => openrouterWireModelId(modelId),
  // The reasoning dial rides exactly the vocabulary the LIVE row states
  // (openrouterEffortVocabularyFor — the same read the capability edge
  // offers the operator), so display equals dispatch by construction.
  buildExtras: args =>
    buildOpenrouterExtras({
      ...args,
      vocabulary: openrouterEffortVocabularyFor(`openrouter/${args.wireModel}`),
    }),
  // OpenRouter content-negotiates on `claude-cli/*` agents (they receive an
  // agent-compatibility model view, not the catalogue) — every OpenRouter
  // request presents the product-true identity instead.
  extraHeaders: () => ({ 'user-agent': getProductUserAgent() }),
  onResponseHeaders: headers => {
    recordOpenrouterRateHeaders(headers)
    // Fire-and-forget: the polled /key endpoint is the credit truth the
    // usage owner reads; a turn is the natural refresh edge. The live
    // catalogue rides the same edge (TTL'd): it decides the context window
    // this session budgets and compacts against (capabilities.ts), and the
    // wire-id healing above reads it.
    void refreshOpenrouterKeyUsage().catch(() => {})
    const account = resolveOpenrouterAccount()
    if (account) void refreshOpenrouterCatalogue(account.keySource).catch(() => {})
  },
}

export function openrouterLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('openrouter')
}

/** The provider-aware callModel branch for OpenRouter. */
export async function* openrouterCallModel(
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  yield* compatChatCallModel(openrouterLaneProfile, params)
}
