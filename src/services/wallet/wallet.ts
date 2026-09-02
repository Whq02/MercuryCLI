// ============================================================================
//  services/wallet — the generic multi-auth account owner (operator-ratified).
//
//  ONE owner for login ENTRIES — each entry = provider × auth-kind × account
//  identity. A FACADE over the existing credential custodians, never a new
//  secret store, a parallel refresh path, or a provider adapter:
//
//    · anthropic subscription-oauth — the /accounts slot estate (ONE entry
//      per signed-in scope; utils/accounts/scopeScan is the shared scan);
//    · anthropic api-key            — env / helper / login-managed key
//      presence (utils/auth is the custodian; only the SOURCE is read);
//    · openai subscription-oauth    — the Mercury-owned token store
//      (openaiAccounts); ENUMERATION is engines-independent (an entry
//      existing ≠ the lane being usable — usability stays with
//      providerUsability);
//    · openai api-key               — env OPENAI_API_KEY / the auth-scoped
//      secret store (presence + source only).
//
//  Laws:
//    - entry ids are STABLE, NON-SECRET, and DERIVED from custodian facts
//      (never a new id registry, never key/token material);
//    - no WalletEntry field ever carries a secret — labels/identities are
//      the custodians' own non-secret views;
//    - /logins ADDS entries (each custodian's own connect flow); removal is
//      the custodian's own disconnect — the wallet routes, never stores;
//    - the ACTIVE entry per provider follows each custodian's existing
//      arbitration (the slot pin · the OpenAI source preference), and for
//      engine lanes it is engines-gated exactly like dispatch is.
// ============================================================================
import { scanAccountScopes } from '../../utils/accounts/scopeScan.js'
import { getAnthropicApiKeyWithSource, isClaudeAISubscriber } from '../../utils/auth.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiApiKey,
  subscriptionConnected,
} from '../providers/openai/openaiAccounts.js'
import {
  readMintedOpenrouterKey,
  resolveOpenrouterApiKey,
} from '../providers/openrouter/openrouterAccounts.js'
import {
  geminiOauthConnected,
  resolveGeminiAccount,
  resolveGeminiApiKey,
} from '../providers/gemini/geminiAccounts.js'
import { readStoredOpenrouterApiKey } from '../../utils/router/providerSecrets.js'
import { providerDisplayName } from '../providers/routeLaw.js'

export type WalletProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini'
/** 'oauth': a provider-native OAuth login that is not
 *  a subscription lane (the Gemini Google sign-in). 'api-key' still covers
 *  every key-shaped credential, including OpenRouter's OAuth-MINTED key
 *  (OAuth is its connect mechanism; credits-billed key is its substance). */
export type WalletAuthKind = 'subscription-oauth' | 'oauth' | 'api-key'

/** Stable non-secret entry id, e.g. 'anthropic:oauth:primary' ·
 *  'openai:api-key:env'. */
export type WalletEntryId = string

export interface WalletEntry {
  id: WalletEntryId
  provider: WalletProvider
  kind: WalletAuthKind
  /** Display truth — plan/source facts from the custodian, never a secret. */
  label: string
  identity?: { email?: string; accountId?: string; plan?: string }
  /** Which existing store answers for this entry (forensics + routing). */
  custodian:
    | 'anthropic-slots'
    | 'anthropic-auth'
    | 'openai-accounts'
    | 'openrouter-accounts'
    | 'gemini-accounts'
    | 'provider-secrets'
}

/** Enumerate every login entry that EXISTS, across all custodians. Pure
 *  reads; no probe fires network I/O. Existence is not usability — the
 *  usability answer stays with providerUsability/the adapters. */
export function walletEntries(): WalletEntry[] {
  const entries: WalletEntry[] = []

  // ── anthropic: one oauth entry per SIGNED-IN slot scope ──────────────────
  for (const scope of scanAccountScopes()) {
    if (scope.claudeFamily || !scope.authed) continue
    entries.push({
      id: `anthropic:oauth:${scope.name}`,
      provider: 'anthropic',
      kind: 'subscription-oauth',
      label: scope.email ? `Claude account (${scope.email})` : `Claude account (${scope.name})`,
      identity: {
        ...(scope.email ? { email: scope.email } : {}),
        ...(scope.uuid ? { accountId: scope.uuid } : {}),
      },
      custodian: 'anthropic-slots',
    })
  }

  // ── anthropic: the api-key entry (env / helper / login-managed) ──────────
  try {
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // The helper source reports itself with no key when skipped — presence
    // of the SOURCE is the entry; a subscriber's managed key is their oauth
    // entry's own machinery, not a second identity.
    if ((key !== null || source === 'apiKeyHelper') && source !== 'none' && !isClaudeAISubscriber()) {
      entries.push({
        id: `anthropic:api-key:${source === 'ANTHROPIC_API_KEY' ? 'env' : source === 'apiKeyHelper' ? 'helper' : 'managed'}`,
        provider: 'anthropic',
        kind: 'api-key',
        label: `Anthropic API key (${source})`,
        custodian: 'anthropic-auth',
      })
    }
  } catch {
    /* a CI-mode credential throw is an environment refusing enumeration —
       the other custodians still answer */
  }

  // ── openai: engines-INDEPENDENT existence reads ──────────────────────────
  if (subscriptionConnected()) {
    // Non-secret facts only; the engines-gated resolver enriches when the
    // lane is armed, else the bare connected fact stands.
    const armed = resolveOpenaiAccount()
    const accountId = armed?.kind === 'chatgpt-subscription' ? armed.accountId : undefined
    const plan = armed?.kind === 'chatgpt-subscription' ? armed.planType : undefined
    // WHO: the sign-in's recorded email (the id_token's standard claim) —
    // the identity every wallet surface prints beside the plan fact.
    const email = armed?.kind === 'chatgpt-subscription' ? armed.email : undefined
    entries.push({
      id: `openai:oauth:${accountId ? accountId.slice(0, 8) : 'subscription'}`,
      provider: 'openai',
      kind: 'subscription-oauth',
      label: armed?.kind === 'chatgpt-subscription' ? armed.label : 'ChatGPT subscription',
      identity: {
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
        ...(plan ? { plan } : {}),
      },
      custodian: 'openai-accounts',
    })
  }
  const openaiKey = resolveOpenaiApiKey()
  if (openaiKey) {
    entries.push({
      id: `openai:api-key:${openaiKey.source}`,
      provider: 'openai',
      kind: 'api-key',
      label: `OpenAI API key (${openaiKey.source})`,
      custodian: openaiKey.source === 'env' ? 'openai-accounts' : 'provider-secrets',
    })
  }

  // ── openrouter: the OAuth-minted key + the winning plain key ─────────────
  // The minted key is its own connect identity; the
  //  env/stored pair collapses to the winning source (the openai key-entry
  //  precedent — the /accounts board still shows shadowing per slot).
  if (readMintedOpenrouterKey()) {
    entries.push({
      id: 'openrouter:oauth-key',
      provider: 'openrouter',
      kind: 'api-key',
      label: 'OpenRouter (OAuth-minted key)',
      custodian: 'openrouter-accounts',
    })
  }
  {
    const envKey = process.env.OPENROUTER_API_KEY?.trim()
    const storedKey = readStoredOpenrouterApiKey()
    if (envKey || storedKey) {
      entries.push({
        id: `openrouter:api-key:${envKey ? 'env' : 'stored'}`,
        provider: 'openrouter',
        kind: 'api-key',
        label: envKey ? 'OpenRouter API key (env)' : 'OpenRouter API key (stored)',
        custodian: envKey ? 'openrouter-accounts' : 'provider-secrets',
      })
    }
  }

  // ── gemini: the Google OAuth login + the winning key-ladder entry ────────
  if (geminiOauthConnected()) {
    entries.push({
      id: 'gemini:oauth',
      provider: 'gemini',
      kind: 'oauth',
      label: 'Google account (OAuth)',
      custodian: 'gemini-accounts',
    })
  }
  {
    const geminiKey = resolveGeminiApiKey()
    if (geminiKey) {
      entries.push({
        id: `gemini:api-key:${geminiKey.source}`,
        provider: 'gemini',
        kind: 'api-key',
        label:
          geminiKey.source === 'env-google'
            ? 'Gemini API key (GOOGLE_API_KEY env)'
            : geminiKey.source === 'env-gemini'
              ? 'Gemini API key (GEMINI_API_KEY env)'
              : 'Gemini API key (stored)',
        custodian: geminiKey.source === 'stored' ? 'provider-secrets' : 'gemini-accounts',
      })
    }
  }

  return entries
}

/** Item A: the not-logged-in gate's PURE
 *  decision over the wallet + the session model's route. Three states:
 *    · 'not-logged-in' — the wallet is EMPTY (no provider anywhere): the
 *      full red refusal;
 *    · 'provider-missing' — entries exist but none serves the session
 *      model's provider: a provider-specific steering line (steer to
 *      /model for the connected provider, /logins to add the missing one);
 *    · 'ok' — the session model's provider is connected: NO banner (being
 *      signed out of a provider you are not using is not a warning). */
export type NotLoggedInGate =
  | { state: 'ok' }
  | { state: 'not-logged-in' }
  | { state: 'provider-missing'; missingProvider: string; steering: string }

export function notLoggedInGateDecision(
  entries: readonly WalletEntry[],
  /** The family whose account the SESSION bills (utils/accounts/
   *  sessionAccount's composer: the main model's declared route, or — on
   *  the computed default — the family the default landed on or is being
   *  composed for). null = no family — no wallet custodian claims it, so
   *  the gate answers 'ok' exactly like the key lanes. A caller that read
   *  the main model's route alone kept naming Anthropic after the default
   *  had moved to another family's key. */
  route: string | null,
): NotLoggedInGate {
  // Key-lane routes (zai and the other key-lane families) have no wallet
  // custodian — their credentials live in the provider-secret store and the
  // lane's own callModel refuses honestly when keyless. The wallet gate is a
  // wallet-lane concept; a key-lane session is never steered to /logins.
  if (route !== 'anthropic' && route !== 'openai') return { state: 'ok' }
  const openaiConnected = entries.some(e => e.provider === 'openai')
  const anthropicConnected = entries.some(e => e.provider === 'anthropic')
  const sessionProviderConnected = route === 'openai' ? openaiConnected : anthropicConnected
  if (sessionProviderConnected) return { state: 'ok' }
  if (entries.length === 0) return { state: 'not-logged-in' }
  // The missing family by its one-owner display name (the wallet lanes are
  // two today; the spelling never hand-picks between them).
  const missingProvider = providerDisplayName(route)
  // The way in rides the one route grammar every family speaks
  // ('/logins <family> or <ENV_KEY>' — the accounts board's owner).
  const { familyRouteWords } =
    require('../providers/accountSlots.js') as typeof import('../providers/accountSlots.js')
  return {
    state: 'provider-missing',
    missingProvider,
    steering: `No ${missingProvider} account for the current model · /model switches to a connected provider · ${familyRouteWords(route)} adds one`,
  }
}

/**
 * The ACTIVE entry for a provider — the one a dispatch on that provider
 * would bill. Follows each custodian's existing arbitration; an engine
 * lane with the gate off has NO active entry (exactly like dispatch).
 */
export function activeWalletEntry(provider: WalletProvider): WalletEntry | undefined {
  const entries = walletEntries()
  if (provider === 'openrouter') {
    // The key resolution IS the arbitration (env > OAuth-minted > stored).
    const active = resolveOpenrouterApiKey()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'openrouter' &&
        (active.source === 'oauth' ? e.id === 'openrouter:oauth-key' : e.id.startsWith('openrouter:api-key')),
    )
  }
  if (provider === 'gemini') {
    // The account resolver owns arbitration (preference; OAuth-first).
    const active = resolveGeminiAccount()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'gemini' &&
        (active.kind === 'oauth' ? e.kind === 'oauth' : e.kind === 'api-key'),
    )
  }
  if (provider === 'openai') {
    // The engines-gated resolver IS the arbitration owner (preference,
    // subscription-first); map its answer onto the enumerated entry.
    const active = resolveOpenaiAccount()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'openai' &&
        (active.kind === 'chatgpt-subscription'
          ? e.kind === 'subscription-oauth'
          : e.kind === 'api-key'),
    )
  }
  // anthropic: the CURRENT scope's entry (the slot pin already resolved the
  // billing scope at boot — isCurrent tracks it), else the api-key entry.
  const scopes = scanAccountScopes()
  const current = scopes.find(s => s.isCurrent && s.authed && !s.claudeFamily)
  if (current) {
    return entries.find(e => e.id === `anthropic:oauth:${current.name}`)
  }
  return entries.find(e => e.provider === 'anthropic' && e.kind === 'api-key')
}
