// ============================================================================
//  providers/providerUsage — the per-provider usage/limits/identity FACADE
//  (stage 9; docs/decisions/wallet-architecture.md).
//
//  providerUsability answers "can this provider take work right now";
//  THIS module answers "who am I on it, what did this session spend, where
//  are its limits" — one owner the display surfaces consume so they stop
//  reading provider-specific singletons directly. Truth sources:
//    · identity      — the wallet (entries + the active entry);
//    · limits        — anthropic: the observed live windows (claudeAiLimits);
//                      openai: the observed limit record (openaiLimitState —
//                      this lane's windows arrive per-request);
//    · sessionSpend  — the ONE provider-neutral ledger (getModelUsage),
//                      partitioned by the routing law.
//
//  The ~49 pre-facade isClaudeAISubscriber/claudeAiLimits import sites are a
//  NAMED follow-up migration (the decision record tracks it) — everything
//  the parity work touched rides here.
// ============================================================================
import { getModelUsage, getUnpricedTurns } from '../../bootstrap/state.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { modelPricingBasis } from '../../utils/modelCost.js'
import { buildRouterModelSnapshot, type RouterModelSnapshot } from '../../utils/router/modelRegistry.js'
import { resolveZaiApiKey } from '../../utils/router/providerDiscovery.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import { formatClock, formatCountdown, quotaWindows, type QuotaWindow } from '../../utils/cockpit/quota.js'
import {
  currentLimits,
  getRawUtilization,
  getUsageCredentialEpoch,
  WEEKLY_POOL_CLAIMS,
  weeklyPoolClaimForModel,
  type RateLimitType,
  type WeeklyPoolClaim,
} from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { activeWalletEntry, walletEntries, type WalletEntry } from '../wallet/wallet.js'
import { providerDisplayName } from './routeLaw.js'
import { declaredRouteOf, PROVIDER_ID_SPACES } from './callModelRouter.js'
import {
  NO_USAGE_READ_WORDS,
  USAGE_POLL_TTL_MS,
  USAGE_RESPONSE_FRESH_MS,
  usageFreshness,
  usageSourceWords,
  usageStaleTail,
  type UsageFeed,
} from './usageFreshness.js'
import {
  openaiLimitWindow,
  openaiObservedUsage,
  type OpenaiLimitWindow,
  type OpenaiObservedUsage,
} from './openai/openaiLimitState.js'
import { resolveOpenrouterApiKey } from './openrouter/openrouterAccounts.js'
import {
  openrouterLimitWindow,
  openrouterObservedKeyUsage,
  refreshOpenrouterKeyUsage,
  type OpenrouterKeyUsage,
  type OpenrouterLimitWindow,
} from './openrouter/openrouterUsageState.js'
import {
  resolveGeminiAccount,
  type GeminiAccountRef,
} from './gemini/geminiAccounts.js'
import { GEMINI_USAGE_ABSENCE_NOTE, geminiLimitWindow, type GeminiLimitWindow } from './gemini/geminiUsageState.js'
import {
  resolveHuggingfaceAccount,
  type HuggingfaceAccountRef,
} from './huggingface/huggingfaceAccounts.js'
import {
  HUGGINGFACE_USAGE_ABSENCE_NOTE,
  huggingfaceLimitWindow,
  huggingfaceObservedRate,
  type HuggingfaceLimitWindow,
} from './huggingface/huggingfaceUsageState.js'
import { resolveLocalAccount, type LocalAccountRef } from './local/localAccounts.js'
import { refreshLocalDiscovery } from './local/localDiscovery.js'

export type UsageProvider = 'anthropic' | 'openai'

export interface ProviderSessionSpend {
  /** The prompt as sent: uncached input plus the cached prefix READ plus the
   *  prefix WRITTEN (the operator-facing total). The three input-side
   *  counters are disjoint on the Anthropic lane; off it cache-write is
   *  structurally zero, so one expression means one quantity everywhere
   *  (FN-018 rank 10: the sum dropped cache-creation, understating the
   *  Anthropic column by the whole cache-write count). */
  inputTokens: number
  outputTokens: number
  /** Ledger USD — real spend on api-key lanes, a published-rate estimate on
   *  subscription lanes (the consumer labels it per the active entry kind). */
  costUSD: number
  /** Distinct models that ran on this lane this session. */
  models: number
  /** Present when the lane's USD is not wholly at recorded rates:
   *  `unpricedTurns` (and the `unpricedModels` they ran on) are the ledger's
   *  own count of settled turns it could not price — their tokens count,
   *  their USD is not in costUSD — and `estimatedModels` ran at a listed
   *  floor or a same-family estimate (the pricing owner's basis). The
   *  surfaces spell the figure through cost-tracker's formatLaneSpend, so
   *  an unpriced lane reads "unpriced", never "$0.00", and a mixed lane says
   *  "+ N unpriced turns" beside its figure — the caveat never stays on the
   *  headline alone (FN-018 rank 3's noted gap). */
  pricing?: { estimatedModels: number; unpricedModels: number; unpricedTurns: number }
}

export interface ProviderUsageView {
  provider: UsageProvider
  /** The entry a dispatch would bill (undefined: nothing active/armed). */
  activeEntry?: WalletEntry
  /** Every existing entry for the provider (existence ≠ usability). */
  entries: WalletEntry[]
  sessionSpend: ProviderSessionSpend
  limits:
    | { kind: 'anthropic-windows'; status: typeof currentLimits.status; raw: ReturnType<typeof getRawUtilization> }
    | { kind: 'openai-observed'; window: OpenaiLimitWindow }
}

// ── provider FAMILY presence ─────────────────────
//  The ONE enumeration the settings surfaces (/config rows · /usage sections ·
//  /accounts provider rows · the /usage command gate) derive from: the
//  provider families the router catalogue knows, each with its credential
//  PRESENCE from the family's owning resolver — never a hand-kept provider
//  pair, never an if/anthropic-else/openai ladder at a surface. A future
//  adapter added to modelRegistry appears on every consumer with no edit
//  there. Presence is EXISTENCE, never validity or usability (those stay with
//  providerUsability/the adapters); no secret ever rides this surface.

export interface ProviderFamilyPresence {
  id: RouterProviderId
  available: boolean
  reason?: string
  /** A credential EXISTS for this family (existence — never validity). */
  credentialed: boolean
  /** The owning resolver's display words for the present credential
   *  (plan/source facts, never a secret); undefined when absent. */
  credentialLabel?: string
  /** WHO is signed in, when the family's owning store recorded an identity
   *  (the account email of a subscription sign-in, a Hub username) — never
   *  a secret; undefined when the credential carries none (a key, a local
   *  server, a token without the claim). The identity words every surface
   *  prints prefer this over the plan label (presenceIdentityWords). */
  identity?: string
}

/** Injectable reads for provers; production callers pass nothing. */
export interface ProviderFamilyReads {
  claudeSubscriber?: () => boolean
  subscriptionType?: () => string | null
  anthropicApiKeyPresent?: () => boolean
  /** The bearer-token ladder's answer (utils/auth getAuthTokenSource): an
   *  env bearer such as ANTHROPIC_AUTH_TOKEN is a dispatchable credential
   *  that neither the subscriber nor the key read sees. */
  bearerTokenSource?: () => { source: string; hasToken: boolean }
  /** The Anthropic account snapshot's email (the profile the sign-in
   *  stored) — identity display only, read when the subscription seat is
   *  the credential. */
  anthropicEmail?: () => string | undefined
  /** An engine family's recorded identity from its OWNING resolver (the
   *  ChatGPT sign-in's email, the Hub username) — undefined when the store
   *  holds none. */
  engineIdentity?: (id: RouterProviderId) => string | undefined
}

/**
 * THE identity words for a family's credential — ONE composer every surface
 * prints (the boot face's account chip, /status, the /accounts board's
 * main-loop row, /defaultprovider, the headless auth verb): the recorded
 * identity when the owning store holds one, else the credential's
 * plan/source label; undefined when nothing is present. A surface that
 * needs the plan word beside the identity reads credentialLabel itself —
 * this composer never invents a second spelling of either.
 */
export function presenceIdentityWords(
  presence: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'>,
): string | undefined {
  if (!presence.credentialed) return undefined
  return presence.identity ?? presence.credentialLabel
}

/** The engine families' recorded identities, each from its owning store —
 *  a refusing custodian names nobody (undefined), never a throw. */
function engineIdentityLive(id: RouterProviderId): string | undefined {
  try {
    if (id === 'openai') {
      // The ACTIVE account's identity (the same account the presence label
      // describes): the ChatGPT sign-in records the id_token's email claim;
      // an API key records none.
      const { resolveOpenaiAccount } =
        require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.email
    }
    if (id === 'huggingface') return resolveHuggingfaceAccount()?.username
  } catch {
    /* a custodian that cannot answer names no identity */
  }
  return undefined
}

/** The Anthropic family's credential presence — THE derivation behind
 *  providerFamilyPresences()'s anthropic row, exported so a surface that
 *  needs only this family's fact (the /model catalogue gate and its group
 *  detail, the boot splash chip) reads the same owner without building the
 *  whole provider snapshot. Existence, never validity: a credential that the
 *  main loop's own resolvers (utils/auth) would hand the wire — the OAuth
 *  subscription, the API-key ladder, or an env bearer token. */
export function anthropicCredentialPresence(
  reads?: ProviderFamilyReads,
): { credentialed: boolean; credentialLabel?: string; identity?: string; expired?: boolean } {
  const subscriber = reads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const plan = reads?.subscriptionType?.() ?? getSubscriptionType()
  const keyPresent =
    reads?.anthropicApiKeyPresent?.() ??
    ((): boolean => {
      try {
        return getAnthropicApiKey() !== null
      } catch {
        // The no-credential environments THROW here (the CI/test
        // refusal in utils/auth) — enumeration reads that as an absent
        // key, the wallet's own precedent: a refusing custodian never
        // crashes the derived surfaces, and the other custodians still
        // answer. (Found live: deriveFamilySlotGroups over a
        // bare NODE_ENV=test home crashed every presence consumer.)
        return false
      }
    })()
  // The env bearer sources (ANTHROPIC_AUTH_TOKEN and the OAuth-token env
  // spellings) ARE the wire's credential when set (services/api/client) —
  // the API client and the health AUTH row honour them, so the presence
  // owner counts them too. 'claude.ai' is the subscriber case already read
  // above; 'apiKeyHelper' is the key ladder's.
  const bearer = reads?.bearerTokenSource?.() ?? readBearerTokenSource()
  const envBearer =
    bearer.hasToken && bearer.source !== 'claude.ai' && bearer.source !== 'apiKeyHelper' && bearer.source !== 'none'
  const credentialLabel = subscriber
    ? `Claude subscription${plan ? ` (${plan})` : ''}`
    : keyPresent
      ? 'Anthropic API key'
      : envBearer
        ? `Anthropic bearer token (${bearer.source})`
        : undefined
  // PRESENT-BUT-DEAD (small-fix bundle item 11): the estate may have already
  // OBSERVED the claude.ai sign-in dead (invalid_grant blanked the refresh
  // token; expiry with none to spend). Existence stays true — the credential
  // is stored and the wire would still send it — but the surfaces reading
  // this owner (the /model group detail, the health AUTH row) must stop
  // pretending ready. Never a probe: recorded state only.
  const expired = ((): boolean => {
    try {
      return isAnthropicOAuthSignInExpired()
    } catch {
      return false
    }
  })()
  // WHO: the subscription seat's account email, from the profile the sign-in
  // stored (the board's live verification heals that snapshot). A key or an
  // env bearer names no account — the label is their honest identity.
  const identity = subscriber ? readAnthropicEmail(reads) : undefined
  return {
    credentialed: credentialLabel !== undefined,
    ...(credentialLabel !== undefined ? { credentialLabel } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(expired ? { expired: true } : {}),
  }
}

/** The stored account email, render-safe (a refusing config read names
 *  nobody); blank spellings read as absent. */
function readAnthropicEmail(reads?: ProviderFamilyReads): string | undefined {
  try {
    const email = reads?.anthropicEmail ? reads.anthropicEmail() : getOauthAccountInfo()?.emailAddress
    return typeof email === 'string' && email.trim() !== '' ? email.trim() : undefined
  } catch {
    return undefined
  }
}

/** The bearer ladder, render-safe: the CI/test no-credential throw reads
 *  as no token (a state, not an error). */
function readBearerTokenSource(): { source: string; hasToken: boolean } {
  try {
    return getAuthTokenSource()
  } catch {
    return { source: 'none', hasToken: false }
  }
}

export function providerFamilyPresences(
  providers: RouterModelSnapshot['providers'] = buildRouterModelSnapshot().providers,
  reads?: ProviderFamilyReads,
): ProviderFamilyPresence[] {
  return providers.map((provider): ProviderFamilyPresence => {
    if (provider.id === 'anthropic') {
      // The main loop's own credential owners (utils/auth), exactly as the
      // health AUTH row reads them — through the ONE anthropic derivation.
      return {
        id: provider.id,
        available: provider.available,
        ...(provider.reason !== undefined ? { reason: provider.reason } : {}),
        ...anthropicCredentialPresence(reads),
      }
    }
    // Engine families: the adapter's own account view (kind + source label —
    // status() self-primed discovery, describe() reads the primed cache),
    // plus the identity the family's owning store recorded for it.
    const account = provider.description.account
    const identity = account.kind !== 'none' ? (reads?.engineIdentity ?? engineIdentityLive)(provider.id) : undefined
    return {
      id: provider.id,
      available: provider.available,
      ...(provider.reason !== undefined ? { reason: provider.reason } : {}),
      credentialed: account.kind !== 'none',
      ...(account.kind !== 'none' ? { credentialLabel: account.label } : {}),
      ...(identity !== undefined && identity !== '' ? { identity } : {}),
    }
  })
}

/** The /usage availability gate: ANY family with a credential. */
export function anyProviderCredentialed(): boolean {
  return providerFamilyPresences().some(family => family.credentialed)
}

/** The session ledger partition for one provider family (the routing law). */
export function providerSessionSpend(route: RouterProviderId): ProviderSessionSpend {
  return spendForRoute(route)
}

function spendForRoute(route: RouterProviderId | 'unrecognised'): ProviderSessionSpend {
  const usage = getModelUsage()
  const unpriced = getUnpricedTurns()
  const spend: ProviderSessionSpend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  let estimatedModels = 0
  let unpricedModels = 0
  let unpricedTurns = 0
  for (const [model, record] of Object.entries(usage)) {
    // Paint-time grouping: a declared family groups its own ids; the
    // stranger bucket groups exactly the ids no family declares.
    if ((declaredRouteOf(model) ?? 'unrecognised') !== route) continue
    spend.models += 1
    spend.inputTokens += record.inputTokens + record.cacheReadInputTokens + record.cacheCreationInputTokens
    spend.outputTokens += record.outputTokens
    spend.costUSD += record.costUSD
    // The ledger's own count of the turns it could not price (a wire-
    // stated cost is a price even when the owner holds no rate), and the
    // pricing owner's basis for the estimate mark — the lane's USD is
    // labelled by how it was arrived at, never presented as a bill when it
    // is a floor, a same-family estimate or an unrecorded rate.
    const turns = unpriced[model] ?? 0
    if (turns > 0) {
      unpricedModels += 1
      unpricedTurns += turns
    } else {
      const basis = modelPricingBasis(model)
      if (basis === 'floor' || basis === 'family-estimate') estimatedModels += 1
    }
  }
  if (estimatedModels > 0 || unpricedTurns > 0) spend.pricing = { estimatedModels, unpricedModels, unpricedTurns }
  return spend
}

// ── the ACTIVE-SOURCE usage view (model-truth lane) ──────────────
//  ONE derivation, TWO renderers (the settings Usage tab + the telemetry
//  rail's USAGE panel): the usage of whatever account source is actively
//  serving THIS session, in the shape that source honestly has —
//    · anthropic subscription → the 5h/7d live windows (the SAME
//      claudeAiLimits store the cap-failover dispatch decision reads via
//      currentLimits.status — screen and throttle can never disagree);
//    · openai subscription    → the observed x-codex usage bands (the SAME
//      openaiLimitState module the dispatch-side 429 pause reads);
//    · an active API key      → billing/spend truth for the key (no
//      subscription windows exist for it — an honest shape, never a bar);
//    · nothing credentialed   → shape 'none' (the renderer says so).
//  Usage numbers are perishable provider facts: every window view carries
//  its observation stamp where the store has one, and absence renders as
//  labeled absence — never a fabricated 0%.

export interface UsageWindowView {
  /** Stable key for renderers/tests ('5h' · '7d' · 'wk' · a derived label). */
  key: string
  /** Display label — derived from the window the source STATED, never assumed. */
  label: string
  state: 'live' | 'unavailable'
  usedPct?: number
  resetsAtMs?: number
  observedAtMs?: number
  /** The feed that stated the figure ('endpoint' · 'headers' · 'seed') and
   *  the reader's freshness horizon for it — the one vocabulary
   *  (usageFreshness) turns these into the source + age words every
   *  renderer paints; a view without them says nothing about its age. */
  source?: UsageFeed
  freshForMs?: number
}

/** The window that caps the session model HARDEST right now — the
 *  highest-used live window among those that apply to it: the family's
 *  shared windows, plus (on the first-party subscription) the per-model
 *  weekly pool of the model's own family. A pool for another family never
 *  binds (the Fable week never caps a Sonnet turn). */
export interface UsageBindingView {
  window: UsageWindowView
  /** The wire claim, on the first-party subscription lane. */
  claim?: RateLimitType
  /** The window's name in the family's own vocabulary ('Fable limit' ·
   *  'weekly window' · 'credit cap') — the strip warning's word. */
  windowName: string
}

/** The provider-stated credit balance for an api-key source, or the honest
 *  absence of one. 'reported' carries the figure verbatim with its reader,
 *  feed and stamp; 'unreported' carries the reason — the provider exposes
 *  no balance road this owner reads, or the reader has not been asked yet.
 *  Never a computed spend presented as a balance. */
export interface UsageCreditsView {
  state: 'reported' | 'unreported'
  /** The figure as the provider stated it ('USD 12.34'). */
  display?: string
  /** The narrow-column spelling of the same fact ('cap 7.50' · 'not read
   *  yet') — the rail's row; never a second fact. */
  compact?: string
  source?: UsageFeed
  observedAtMs?: number
  freshForMs?: number
  /** The 'unreported' arm's one line. */
  reason?: string
}

/** The one spelling for a lane whose provider publishes no balance road. */
export const CREDITS_UNREPORTED_WORDS = 'not reported by the provider'

export type ActiveUsageShape = 'subscription-windows' | 'api-spend' | 'none'

/** A provider-stated usage figure that is not a percent window — a credit
 *  total, a remaining-request count, a stated tier — in the provider's OWN
 *  unit and words, verbatim, with its observation stamp. The one shape
 *  every family's non-window facts ride, so a surface paints every family
 *  the same way and every figure it shows traces to a reader. */
export interface UsageFigureView {
  /** Stable key for renderers/tests. */
  key: string
  /** What the figure is, in the provider's vocabulary ('credits used this week'). */
  label: string
  /** The figure as the provider stated it (a number formatted once, or a word). */
  value: string
  observedAtMs?: number
  resetsAtMs?: number
}

export interface ActiveSourceUsage {
  /** 'unrecognised' = the session model matches no family's declaration —
   *  the card paints the honest word with no borrowed billing source. */
  provider: RouterProviderId | 'unrecognised'
  /** 'oauth' (auth lane): a provider-native OAuth login that is
   *  not a subscription lane (the Gemini Google sign-in); 'keyless': a
   *  reachable server that takes no credential at all (local models) —
   *  connected, nothing to meter. */
  sourceKind: 'subscription-oauth' | 'oauth' | 'api-key' | 'keyless' | 'none'
  /** The quiet renderer label (operator vocabulary): a subscription names
   *  its provider ('Anthropic usage' · 'OpenAI usage'); an active API key
   *  is 'API usage'; an uncredentialed lane keeps the provider name. */
  label: string
  shape: ActiveUsageShape
  windows: UsageWindowView[]
  /** The per-model weekly POOLS the family reports beside its shared
   *  windows (the first-party subscription's Fable · Opus · Sonnet weeks,
   *  keyed by the wire claim) — every renderer folds them into the family's
   *  block. A family that reports none has none: empty, never fabricated. */
  pools: UsageWindowView[]
  /** The window that binds the session model hardest (activeSourceUsage
   *  resolves it against the model; a per-provider read has no model and
   *  carries none). */
  binding?: UsageBindingView
  /** The api-key source's credit balance, reported or honestly not (absent
   *  on subscription and metering-free lanes — a subscription meters
   *  windows, not credits). */
  credits?: UsageCreditsView
  spend: ProviderSessionSpend
  /** Present while the provider currently reports a reached limit. */
  limited?: { resetsAtMs: number }
  /** Provider-stated account balance where the provider's API exposes one
   *  (DeepSeek GET /user/balance today) — a LAST-OBSERVED record with its
   *  stamp; absence means the provider stated nothing, never zero. */
  balance?: {
    /** e.g. 'USD 12.34' — the provider's own currency + amount strings. */
    display: string
    observedAtMs: number
  }
  /** The provider-stated figures beyond the windows and the balance (an
   *  OpenRouter key's credit totals, a Hugging Face response's remaining
   *  requests) — LAST-OBSERVED records with their stamps; empty until the
   *  family's reader has observed something, never a fabricated figure. */
  figures?: UsageFigureView[]
  /** The family's reader speaking about ITSELF — its last poll failed, or
   *  the provider marked the account unavailable — one labelled line; the
   *  last observation (if any) still stands beside it. */
  readerNote?: string
  /** Why this source has NO meter, in one line, when that is the honest
   *  state of a CONNECTED source (no spend API documented; a local server
   *  meters nothing; an API key on a lane whose usage endpoint Mercury does
   *  not read) — renderers paint it instead of a "fills later" hint. Present
   *  EXACTLY when the source publishes nothing this owner reads. */
  absence?: string
  /** The honest why-not for sourceKind 'none' — the family's own connect
   *  route in one short line. Present EXACTLY when nothing is connected on
   *  the active lane, so every meter renderer (rail · deck) paints the same
   *  truth the settings tab's not-connected line tells; a "fills after
   *  first reply" hint over a signed-out lane is a promise that cannot come
   *  true (the deck's law 1, now owned here for every renderer). */
  whyNot?: string
  /** The ACTIVE source's billing tier, in the owning custodian's real words
   *  (the tier law): a Claude subscription names its plan ('Claude Max'), an
   *  OpenAI subscription its ChatGPT tier ('ChatGPT Plus'), every api-key
   *  lane is 'API billing', a tierless provider OAuth names its sign-in
   *  ('Google sign-in'). Absent ONLY when nothing is logged in on the lane —
   *  every tier renderer derives from THIS field, never its own words. */
  tier?: string
}

/** Injectable reads for provers; production callers pass nothing. */
export interface ActiveUsageReads {
  route?: (model: string) => RouterProviderId
  activeEntry?: (provider: UsageProvider) => WalletEntry | undefined
  anthropicWindows?: () => { fiveHour: QuotaWindow; sevenDay: QuotaWindow }
  /** The per-model weekly pools (anthropicPoolWindowViews' live read). */
  anthropicPoolWindows?: () => UsageWindowView[]
  openaiObserved?: () => OpenaiObservedUsage
  openaiLimited?: () => OpenaiLimitWindow
  zaiKeyPresent?: () => boolean
  openrouterKeyPresent?: () => boolean
  openrouterObserved?: () => { usage: OpenrouterKeyUsage | null; lastError?: string }
  openrouterLimited?: () => OpenrouterLimitWindow
  geminiAccount?: () => GeminiAccountRef | undefined
  geminiLimited?: () => GeminiLimitWindow
  huggingfaceAccount?: () => HuggingfaceAccountRef | undefined
  huggingfaceLimited?: () => HuggingfaceLimitWindow
  /** The last RateLimit facts a Hugging Face response stated (the owner's
   *  remaining-requests figure). */
  huggingfaceRate?: () => { remaining: number; resetsAtMs?: number; observedAtMs: number } | null
  localAccount?: () => LocalAccountRef | undefined
  /** Presence per key-lane family + the DeepSeek
   *  balance record (injectables for hermetic proof). */
  laneCredentialed?: (provider: RouterProviderId) => boolean
  deepseekBalance?: () => DeepseekObservedBalanceView | null
  /** The Moonshot family's account from its OWNING resolver (a Kimi sign-in
   *  or a key) and the two usage records each source has. */
  moonshotAccount?: () => { kind: 'kimi-oauth' | 'api-key' } | undefined
  moonshotBalance?: () => MoonshotObservedBalanceView | null
  kimiManagedUsage?: () => KimiManagedUsageView | null
  spend?: (route: RouterProviderId) => ProviderSessionSpend
  /** The Anthropic subscription's live plan word (tier law injectable). */
  anthropicPlan?: () => string | null
}

/** The shape the balance read serves (mirrors deepseekUsageState's record —
 *  typed here so the usage owner never imports the lane module's internals
 *  beyond the accessor). */
export interface DeepseekObservedBalanceView {
  observedAtMs: number
  isAvailable: boolean
  balances: { currency: string; totalBalance: string }[]
}

/** Injectable IO for the refresh door (provers pass a fixture fetch and a
 *  clock; production callers pass nothing). */
export interface UsageRefreshIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}

/**
 * THE refresh door — one call per family that samples the provider's usage
 * truth through that family's own reader, TTL-bounded and single-flight
 * inside the reader (the readers never throw; a refused or unreachable
 * endpoint leaves the last observation standing with its stamp). Families
 * that publish nothing this owner reads resolve at once — the owner's
 * `absence` says why, and no request is made. Every surface that wants a
 * fresh figure calls THIS, never a reader module directly, so what a
 * surface shows is always what a reader observed.
 */
export async function refreshProviderUsage(provider: RouterProviderId, io?: UsageRefreshIo): Promise<void> {
  try {
    switch (provider) {
      case 'openrouter':
        await refreshOpenrouterKeyUsage(io)
        return
      case 'deepseek': {
        const { refreshDeepseekBalance } =
          require('./deepseek/deepseekUsageState.js') as typeof import('./deepseek/deepseekUsageState.js')
        await refreshDeepseekBalance(io)
        return
      }
      case 'moonshot': {
        const { refreshKimiManagedUsage, refreshMoonshotBalance } =
          require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
        const { resolveMoonshotAccount } =
          require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
        const account = resolveMoonshotAccount(io?.env)
        if (account?.kind === 'kimi-oauth') await refreshKimiManagedUsage(io)
        else if (account?.kind === 'api-key') await refreshMoonshotBalance(io)
        return
      }
      case 'anthropic': {
        // The subscription's usage endpoint folds into the ONE raw record
        // the window views read (services/api/usage → claudeAiLimits); a
        // key-only or signed-out lane asks nothing.
        const { fetchUtilization } = require('../api/usage.js') as typeof import('../api/usage.js')
        if (isClaudeAISubscriber()) await fetchUtilization()
        return
      }
      case 'local':
        await refreshLocalDiscovery({
          ...(io?.env !== undefined ? { env: io.env } : {}),
          ...(io?.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io?.now !== undefined ? { now: io.now } : {}),
          ...(io?.force !== undefined ? { force: io.force } : {}),
        })
        return
      default:
        // openai (headers arrive per response, no polled endpoint), zai,
        // gemini, huggingface, openai-compat: nothing to poll — the owner's
        // absence line is the truth.
        return
    }
  } catch {
    /* a refresh never fails a surface — the last observation stands, labelled */
  }
}

/** The Moonshot balance read's shape (mirrors moonshotUsageState's record —
 *  provider-stated USD numbers, platform.kimi.ai/docs/api/balance). */
export interface MoonshotObservedBalanceView {
  observedAtMs: number
  availableBalance: number
}

/** The Kimi sign-in's managed-usage record (mirrors moonshotUsageState's
 *  shape — GET {coding base}/usages: the overall quota and the stated rate
 *  windows, used/limit counts with their reset instants). */
export interface KimiManagedUsageView {
  observedAtMs: number
  quota?: KimiUsageWindowView
  windows: KimiUsageWindowView[]
}
export interface KimiUsageWindowView {
  name?: string
  windowMinutes?: number
  used: number
  limit: number
  resetsAtMs?: number
}

/** Live presence per key-lane family (uncached reads —
 *  each family's OWNING resolver; compat counts CONFIGURED, keyless legal). */
function laneCredentialedLive(provider: RouterProviderId): boolean {
  if (provider === 'deepseek') {
    const { resolveDeepseekApiKey } =
      require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
    return resolveDeepseekApiKey() !== undefined
  }
  if (provider === 'openai-compat') {
    const { resolveCompatSlotConfig } =
      require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
    return resolveCompatSlotConfig() !== undefined
  }
  return false
}

function liveDeepseekBalance(): DeepseekObservedBalanceView | null {
  const { deepseekObservedBalance } =
    require('./deepseek/deepseekUsageState.js') as typeof import('./deepseek/deepseekUsageState.js')
  return deepseekObservedBalance()
}

function liveMoonshotBalance(): MoonshotObservedBalanceView | null {
  const { moonshotObservedBalance } =
    require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
  return moonshotObservedBalance()
}

function liveMoonshotAccount(): { kind: 'kimi-oauth' | 'api-key' } | undefined {
  const { resolveMoonshotAccount } =
    require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
  return resolveMoonshotAccount()
}

function liveKimiManagedUsage(): KimiManagedUsageView | null {
  const { kimiObservedManagedUsage } =
    require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
  return kimiObservedManagedUsage()
}

/** The Kimi sign-in's stated windows as window views — the ONE derivation
 *  the settings tab AND the rail meters read: the rate windows shortest
 *  first (the anthropic 5h-then-7d reading order), the overall quota last;
 *  a window without a stated length labels itself 'quota'. Empty until the
 *  usage endpoint has answered (never a fabricated 0%). */
export function kimiManagedWindowViews(usage: KimiManagedUsageView | null): UsageWindowView[] {
  if (!usage) return []
  const seen = new Map<string, number>()
  const view = (w: KimiUsageWindowView, fallbackLabel: string): UsageWindowView => {
    const label = w.windowMinutes !== undefined ? usageWindowLabel(w.windowMinutes) : fallbackLabel
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      ...(w.limit > 0 ? { usedPct: Math.min(100, Math.max(0, (w.used / w.limit) * 100)) } : {}),
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: usage.observedAtMs,
      // A polled endpoint (the managed-usage probe, at the poll TTL).
      source: 'endpoint',
    }
  }
  const windows = [...usage.windows].sort(
    (a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY),
  )
  const views = windows.map(w => view(w, 'win'))
  if (usage.quota) views.push(view(usage.quota, 'quota'))
  return views
}

/** Label for a stated window length — derived, never assumed: ≥6 days reads
 *  as the weekly meter ('wk'); other durations name themselves; an unstated
 *  length is the generic 'win'. */
export function usageWindowLabel(windowMinutes?: number): string {
  if (windowMinutes === undefined) return 'win'
  if (windowMinutes >= 6 * 24 * 60) return 'wk'
  if (windowMinutes >= 24 * 60) return `${Math.round(windowMinutes / (24 * 60))}d`
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`
  return `${Math.round(windowMinutes)}m`
}

/** The Anthropic subscription's 5h/7d windows as window views — the ONE
 *  derivation the settings tab AND the rail meters read (the same
 *  claudeAiLimits raw record the dispatch cap-failover consults; the
 *  endpoint fold in that store means a /usage fetch fills these views the
 *  same instant it fills the tab). Exported for the tab exactly like
 *  openaiObservedWindowViews — never a second decode of the same windows. */
export function anthropicWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const { fiveHour, sevenDay } = (reads?.anthropicWindows ?? quotaWindows)()
  const view = (w: QuotaWindow): UsageWindowView => ({
    key: w.key,
    label: w.key,
    state: w.state === 'live' ? 'live' : 'unavailable',
    ...(w.usedPct !== null ? { usedPct: w.usedPct } : {}),
    ...(w.resetsAtMs !== null ? { resetsAtMs: w.resetsAtMs } : {}),
    // The feed and stamp ride verbatim from the record; both subscription
    // feeds (a response's headers, the usage endpoint a tab samples) have
    // no timer, so they age at the response horizon.
    ...(w.source !== undefined ? { source: w.source, freshForMs: USAGE_RESPONSE_FRESH_MS } : {}),
    ...(w.observedAtMs !== undefined ? { observedAtMs: w.observedAtMs } : {}),
  })
  return [view(fiveHour), view(sevenDay)]
}

const POOL_LABELS: Record<WeeklyPoolClaim, string> = {
  seven_day_fable: 'Fable',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
}

/** The per-model weekly POOLS the usage endpoint states (Fable · Opus ·
 *  Sonnet) as window views, keyed by the wire's own claim so the warning
 *  owner names the pool in the wire vocabulary ("Fable limit"). Endpoint-fed
 *  only (the headers never state them) off the SAME record the 5h/7d views
 *  read. Kept beside activeSourceUsage's windows (the `pools` field), never
 *  inside them: the shared pair stays the shared pair, every renderer folds
 *  the pools into the family's block, and the binding-window pick applies
 *  only the pool of the model's own family. Empty until the endpoint has
 *  answered — never a fabricated 0%. */
export function anthropicPoolWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  if (reads?.anthropicPoolWindows) return reads.anthropicPoolWindows()
  const raw = getRawUtilization()
  const views: UsageWindowView[] = []
  for (const claim of WEEKLY_POOL_CLAIMS) {
    const pool = raw[claim]
    if (!pool || !Number.isFinite(pool.utilization) || !Number.isFinite(pool.resets_at)) continue
    views.push({
      key: claim,
      label: POOL_LABELS[claim],
      state: 'live',
      usedPct: pool.utilization * 100,
      resetsAtMs: pool.resets_at * 1000,
      ...(pool.source !== undefined ? { source: pool.source, freshForMs: USAGE_RESPONSE_FRESH_MS } : {}),
      ...(pool.observedAtMs !== undefined ? { observedAtMs: pool.observedAtMs } : {}),
    })
  }
  return views
}

/** The worst live provider-stated percent window, or null when the source
 *  stated none (absence is never a 0%). */
export function worstLiveWindow(windows: readonly UsageWindowView[]): UsageWindowView | null {
  const live = windows.filter(
    w => w.state === 'live' && typeof w.usedPct === 'number' && Number.isFinite(w.usedPct),
  )
  if (live.length === 0) return null
  return live.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a))
}

/** A first-party window view's wire claim: the shared pair by its meter
 *  key, a per-model pool by the claim it is keyed on. */
export function anthropicClaimOf(view: UsageWindowView): RateLimitType {
  if (view.key === '5h') return 'five_hour'
  if (view.key === '7d') return 'seven_day'
  return view.key as RateLimitType
}

/** An engine window view's word for the one warning grammar — derived from
 *  the label the provider's OWN statement produced. */
export function usageWindowWord(view: UsageWindowView): string {
  if (view.key === 'cap' || view.label === 'cap') return 'credit cap'
  if (view.label === 'quota') return 'quota'
  if (view.label === 'wk') return 'weekly window'
  if (view.label === 'win') return 'usage window'
  return `${view.label} window`
}

/**
 * THE binding-window pick: the highest-used live window among those that
 * apply to `model`. On the first-party subscription the applicable set is
 * the shared 5h/7d pair plus the weekly pool of the model's own family;
 * every other lane's set is its own stated windows. Undefined when nothing
 * live applies (never a fabricated window). Pure over a view.
 */
export function bindingWindowOf(
  view: Pick<ActiveSourceUsage, 'provider' | 'shape' | 'windows' | 'pools'>,
  model: string,
): UsageBindingView | undefined {
  const firstParty = view.provider === 'anthropic' && view.shape === 'subscription-windows'
  const applicable = [...view.windows]
  if (firstParty) {
    const claim = weeklyPoolClaimForModel(model)
    for (const pool of view.pools) if (pool.key === claim) applicable.push(pool)
  }
  const worst = worstLiveWindow(applicable)
  if (worst === null) return undefined
  if (firstParty) {
    const claim = anthropicClaimOf(worst)
    return { window: worst, claim, windowName: rateLimitWindowName(claim) }
  }
  return { window: worst, windowName: usageWindowWord(worst) }
}

/** The binding window for a model on its own lane — the cap-offer and the
 *  strip warning consult THIS, so the offer, the strip and the meters can
 *  never name different windows. */
export function bindingWindowFor(model: string, reads?: ActiveUsageReads): UsageBindingView | undefined {
  return activeSourceUsage({ model, ...(reads !== undefined ? { reads } : {}) }).binding
}

/** The one reset spelling for a prose surface (the doctor row, a summary):
 *  the operator's local clock and the countdown — 'resets 14:32 (in 2h 10m)'. */
export function usageResetWords(resetsAtMs: number | undefined, now: number = Date.now()): string | undefined {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return undefined
  return `resets ${formatClock(resetsAtMs)} (in ${formatCountdown(resetsAtMs - now)})`
}

/** The credits words, one spelling for every lane — prose: 'USD 12.34 ·
 *  endpoint-fed · read 3 s ago' / 'not reported by the provider'; compact
 *  (a narrow column): 'USD 12.34 ↻3m' / 'not reported'. */
export function usageCreditsWords(
  credits: UsageCreditsView | undefined,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  if (credits === undefined) return undefined
  if (credits.state === 'unreported') {
    return style === 'compact' ? (credits.compact ?? 'not reported') : (credits.reason ?? CREDITS_UNREPORTED_WORDS)
  }
  if (style === 'compact') {
    const stale = usageStaleTail(credits, now)
    return `${credits.compact ?? credits.display ?? ''}${stale !== undefined ? ` ${stale}` : ''}`
  }
  const words = usageSourceWords(credits, now)
  return `${credits.display ?? ''}${words !== undefined ? ` · ${words}` : ''}`
}

/** The credits LINE with its label: 'credits: …' (prose) · 'credits …'
 *  (compact). */
export function usageCreditsLine(
  credits: UsageCreditsView | undefined,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  const words = usageCreditsWords(credits, now, style)
  if (words === undefined) return undefined
  return style === 'compact' ? `credits ${words}` : `credits: ${words}`
}

/** The freshest stamped view among a family's windows and pools — the one
 *  whose source + age words stand for the block. */
export function freshestUsageView(views: readonly UsageWindowView[]): UsageWindowView | undefined {
  let best: UsageWindowView | undefined
  for (const v of views) {
    if (v.state !== 'live') continue
    if (best === undefined || (v.observedAtMs ?? -1) > (best.observedAtMs ?? -1)) best = v
  }
  return best
}

/**
 * One family's usage in prose (the doctor row, a headless summary): the
 * tier, every live window and pool with its percent and local reset, the
 * source + age words, the credits line, the reached limit, the honest
 * absence — composed from the owner's view, nothing invented.
 */
export function usageSummaryWords(view: ActiveSourceUsage, now: number = Date.now()): string {
  if (view.sourceKind === 'none') return view.whyNot ?? 'not connected'
  const parts: string[] = []
  if (view.tier !== undefined) parts.push(view.tier)
  const metered = [...view.windows, ...view.pools].filter(w => w.state === 'live' && w.usedPct !== undefined)
  for (const w of metered) {
    const reset = usageResetWords(w.resetsAtMs, now)
    parts.push(`${w.label} ${Math.round(w.usedPct ?? 0)}%${reset !== undefined ? ` · ${reset}` : ''}`)
  }
  const stamped = freshestUsageView(metered)
  const source = stamped !== undefined ? usageSourceWords(stamped, now) : undefined
  if (source !== undefined) parts.push(source)
  if (metered.length === 0 && view.shape === 'subscription-windows') {
    parts.push(`${NO_USAGE_READ_WORDS} yet — fills after the first reply, or /usage samples it`)
  }
  if (view.absence !== undefined) parts.push(view.absence)
  const credits = usageCreditsLine(view.credits, now)
  if (credits !== undefined) parts.push(credits)
  if (view.readerNote !== undefined) parts.push(view.readerNote)
  if (view.limited !== undefined) {
    const reset = usageResetWords(view.limited.resetsAtMs, now)
    parts.push(`limit reached${reset !== undefined ? ` · ${reset}` : ''}`)
  }
  return parts.join(' · ')
}

/** Whether a stamped view is stale at `now` (the renderers' one test). */
export function usageViewIsStale(view: UsageWindowView | UsageCreditsView, now: number = Date.now()): boolean {
  return usageFreshness(view, now).state === 'stale'
}

/** The OpenAI subscription's observed usage bands as window views — the ONE
 *  derivation the settings tab AND the rail meters read (never a second
 *  decode). Empty when the source has stated nothing yet. */
export function openaiObservedWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  return openaiWindowViews(reads)
}

// ── OpenRouter usage truth (auth lane) ───────────────────────────
//  The polled GET /key truth (openrouterUsageState) rendered ONCE here for
//  every surface. The only honest PERCENT this lane has is the per-key credit
//  CAP (usage vs limit, when the key states a cap); credit totals ride the
//  typed facts accessor — never a fabricated time-window meter.

/** The per-key credit-cap meter as a window view ('cap') — empty when the
 *  key states no cap or nothing has been observed. */
export function openrouterObservedWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
  const usage = observed.usage
  if (!usage) return []
  const { limit, limitRemaining } = usage
  if (typeof limit !== 'number' || limit <= 0 || typeof limitRemaining !== 'number') return []
  const usedPct = Math.min(100, Math.max(0, ((limit - limitRemaining) / limit) * 100))
  return [
    {
      key: 'cap',
      label: 'cap',
      state: 'live',
      usedPct,
      observedAtMs: usage.observedAtMs,
      // The polled key endpoint, at the poll TTL.
      source: 'endpoint',
    },
  ]
}

/** The OpenRouter key's credit balance as the key endpoint states it: the
 *  remaining credit under a capped key is the balance fact; an uncapped
 *  key states none there; nothing observed is not read yet — never a
 *  figure the endpoint did not state. */
function openrouterCredits(observed: { usage: OpenrouterKeyUsage | null; lastError?: string }): UsageCreditsView {
  const usage = observed.usage
  if (usage === null) {
    return observed.lastError !== undefined
      ? { state: 'unreported', reason: `not read — ${observed.lastError}`, compact: 'not read' }
      : { state: 'unreported', reason: 'not read yet — /usage samples the key endpoint', compact: 'not read yet' }
  }
  if (typeof usage.limitRemaining === 'number') {
    return {
      state: 'reported',
      display: `${usage.limitRemaining.toFixed(2)} remaining under the key cap`,
      compact: `cap ${usage.limitRemaining.toFixed(2)}`,
      source: 'endpoint',
      observedAtMs: usage.observedAtMs,
      freshForMs: USAGE_POLL_TTL_MS,
    }
  }
  if (usage.limit === null) {
    return {
      state: 'unreported',
      reason: 'the key endpoint states no balance for an uncapped key — the OpenRouter dashboard is the view',
      compact: 'not stated',
    }
  }
  return { state: 'unreported', reason: 'the key endpoint stated no cap or balance', compact: 'not stated' }
}

/** A polled balance record as the credits view (the DeepSeek and Moonshot
 *  balance endpoints): stated ⇒ reported verbatim with its stamp; not yet
 *  observed ⇒ not read yet, never a zero. */
function polledBalanceCredits(balance: { display: string; observedAtMs: number } | undefined): UsageCreditsView {
  return balance !== undefined
    ? { state: 'reported', display: balance.display, compact: balance.display, source: 'endpoint', observedAtMs: balance.observedAtMs, freshForMs: USAGE_POLL_TTL_MS }
    : { state: 'unreported', reason: 'not read yet — /usage samples the balance endpoint', compact: 'not read yet' }
}

const CREDITS_UNREPORTED: UsageCreditsView = { state: 'unreported', reason: CREDITS_UNREPORTED_WORDS, compact: 'not reported' }

/** The last-observed OpenRouter credit facts for the settings tab (typed,
 *  stale-but-labelled) — null until the key endpoint has answered. */
export function openrouterCreditFacts(reads?: ActiveUsageReads): {
  usage: OpenrouterKeyUsage | null
  lastError?: string
} {
  return (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
}

function openaiWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openaiObserved ?? openaiObservedUsage)()
  const bands = [observed.primary, observed.secondary].filter(
    (b): b is NonNullable<typeof b> => b !== undefined && b.usedPct !== undefined,
  )
  // Longer windows last (the anthropic 5h-then-7d reading order).
  bands.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return bands.map(band => {
    const label = usageWindowLabel(band.windowMinutes)
    return {
      key: label,
      label,
      state: 'live' as const,
      usedPct: band.usedPct!,
      ...(band.resetsAtMs !== undefined ? { resetsAtMs: band.resetsAtMs } : {}),
      observedAtMs: band.observedAtMs,
      // Observed on the responses themselves (no polled endpoint).
      source: 'headers' as const,
    }
  })
}

// The hot-path bound: the rail reads this per paint, and the wallet's
// custodian reads touch the filesystem — a short TTL keeps repaints live
// (well inside the rail's own 30s tick) without per-frame fs scans.
// Injected reads (provers) always bypass; the cache is keyed on the model so
// a /model switch re-derives immediately, AND on the usage-credential epoch
// so a credential switch (or the C8 gate close) re-derives immediately too —
// the reset owner's law ('no surface may keep painting the old account's
// meters') would otherwise lose its last ≤2s to this cache.
const ACTIVE_USAGE_CACHE_MS = 2_000
let activeUsageCache: { model: string; atMs: number; epoch: number; value: ActiveSourceUsage } | null = null

/**
 * The active-source usage resolution — the model decides the lane (the
 * routing law), the lane's active wallet entry decides the source kind, and
 * the source kind decides the SHAPE. Pure reads; no network I/O.
 */
export function activeSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  if (opts?.reads === undefined) {
    const model = opts?.model ?? getMainLoopModel()
    const now = Date.now()
    const epoch = getUsageCredentialEpoch()
    if (
      activeUsageCache !== null &&
      activeUsageCache.model === model &&
      activeUsageCache.epoch === epoch &&
      now - activeUsageCache.atMs < ACTIVE_USAGE_CACHE_MS
    ) {
      return activeUsageCache.value
    }
    const value = deriveActiveSourceUsage({ model })
    activeUsageCache = { model, atMs: now, epoch, value }
    return value
  }
  return deriveActiveSourceUsage(opts)
}

/** Every family the routing law declares, in catalogue order — the set the
 *  beside-rows walk (never a hand-kept list of window-capable families:
 *  which lane has a percent meter is the READER's fact, read per family). */
const ALL_FAMILIES: readonly RouterProviderId[] = ['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)]

// The beside-rows walk every family's custodian per paint (the rail's
// 30s tick + per message); the same short TTL and the same credential-epoch
// key as the primary cache keep repaints live without a per-frame fs scan
// across ten families. Injected reads (provers) always bypass.
const OTHER_USAGES_CACHE_MS = 2_000
let otherUsagesCache: {
  primary: RouterProviderId | 'unrecognised'
  atMs: number
  epoch: number
  value: ActiveSourceUsage[]
} | null = null

/** The other signed-in families with a live percent meter beside the
 *  focused source. Signal = at least one live window in the family's OWN
 *  shape (a subscription's rolling windows, a key's stated credit cap) — a
 *  signed-out or windowless lane adds no row (honest quiet). */
export function windowSourceUsages(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): { primary: ActiveSourceUsage; others: ActiveSourceUsage[] } {
  const primary = activeSourceUsage(opts)
  if (opts?.reads !== undefined) {
    return { primary, others: deriveOtherWindowUsages(primary.provider, opts.reads) }
  }
  const now = Date.now()
  const epoch = getUsageCredentialEpoch()
  if (
    otherUsagesCache !== null &&
    otherUsagesCache.primary === primary.provider &&
    otherUsagesCache.epoch === epoch &&
    now - otherUsagesCache.atMs < OTHER_USAGES_CACHE_MS
  ) {
    return { primary, others: otherUsagesCache.value }
  }
  const value = deriveOtherWindowUsages(primary.provider, undefined)
  otherUsagesCache = { primary: primary.provider, atMs: now, epoch, value }
  return { primary, others: value }
}

function deriveOtherWindowUsages(
  primary: RouterProviderId | 'unrecognised',
  reads: ActiveUsageReads | undefined,
): ActiveSourceUsage[] {
  const others: ActiveSourceUsage[] = []
  for (const provider of ALL_FAMILIES) {
    if (provider === primary) continue
    const u = usageForProvider(provider, reads)
    if (u.windows.some(w => w.state === 'live')) others.push(u)
  }
  return others
}

/** 'max' → 'Max' — the custodian's plan word, capitalized for display. */
function planWord(plan: string): string {
  return plan.length > 0 ? plan[0]!.toUpperCase() + plan.slice(1) : plan
}

/** Every api-key lane bills the key — ONE spelling of that tier fact. */
const API_BILLING_TIER = 'API billing'

// The honest absence lines — a CONNECTED source that publishes nothing this
// owner reads says so and names the provider's own view; never a "fills
// later" promise over a lane that cannot fill.
/** Z.AI's API reference lists chat completions only — no balance, usage or
 *  quota endpoint (docs.z.ai/api-reference, checked 2026-09-01); the wire's
 *  billing refusal (laneBillingState) is the one balance fact it states. */
const ZAI_USAGE_ABSENCE_NOTE =
  'Z.AI publishes no usage or balance endpoint (its API reference lists none, checked 2026-09-01) — the Z.AI console is the view'
const COMPAT_USAGE_ABSENCE_NOTE =
  "a custom endpoint publishes no usage Mercury reads — the endpoint's own dashboard is the view"
/** An API key on the two subscription-capable lanes: the subscription
 *  windows belong to a sign-in, and this owner reads no per-key usage
 *  endpoint — the provider's console is the view for the key's spend. */
const API_KEY_USAGE_ABSENCE_NOTE =
  'no usage endpoint is read for an API key on this lane — the provider console is the view'

/** The OpenRouter key's stated credit facts as figures (the provider's own
 *  units — credits — verbatim to two decimals; a null cap is the stated
 *  word "uncapped"; nothing observed is no figure). */
function openrouterFigures(usage: OpenrouterKeyUsage | null): UsageFigureView[] {
  if (!usage) return []
  const observedAtMs = usage.observedAtMs
  const figures: UsageFigureView[] = []
  if (usage.usage !== undefined) {
    figures.push({ key: 'credits-all-time', label: 'credits used (all-time)', value: usage.usage.toFixed(2), observedAtMs })
  }
  if (usage.usageWeekly !== undefined) {
    figures.push({ key: 'credits-week', label: 'credits used this week', value: usage.usageWeekly.toFixed(2), observedAtMs })
  }
  if (typeof usage.limitRemaining === 'number') {
    figures.push({ key: 'cap-remaining', label: 'remaining under the key cap', value: usage.limitRemaining.toFixed(2), observedAtMs })
  } else if (usage.limit === null) {
    figures.push({ key: 'cap', label: 'key cap', value: 'uncapped', observedAtMs })
  }
  if (usage.isFreeTier === true) {
    figures.push({ key: 'tier', label: 'account', value: 'free tier', observedAtMs })
  }
  return figures
}

function deriveActiveSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  const reads = opts?.reads
  const model = opts?.model ?? getMainLoopModel()
  const provider = (reads?.route ?? ((m: string) => declaredRouteOf(m) ?? 'unrecognised'))(model)
  const view = usageForProvider(provider, reads)
  // The session model decides which windows apply — the binding pick is
  // the active-source view's alone (a per-provider read has no model).
  const binding = bindingWindowOf(view, model)
  return binding !== undefined ? { ...view, binding } : view
}

/** One provider's usage record, independent of any session model — the
 *  all-accounts rail rows read this beside the focused source (the ruled
 *  design, operator-sighted: the USAGE panel follows the
 *  FOCUSED chat's provider and shows every logged-in account's windows
 *  where signal exists, the focused provider's first). */
export function usageForProvider(
  provider: RouterProviderId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const spend = provider === 'unrecognised' ? spendForRoute(provider) : (reads?.spend ?? spendForRoute)(provider)

  if (provider === 'zai') {
    const keyPresent = reads?.zaiKeyPresent?.() ?? resolveZaiApiKey() !== undefined
    return keyPresent
      ? { provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_USAGE_ABSENCE_NOTE, credits: CREDITS_UNREPORTED }
      : { provider, sourceKind: 'none', label: 'Z.AI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins zai adds a key' }
  }

  if (provider === 'openrouter') {
    const keyPresent = reads?.openrouterKeyPresent?.() ?? resolveOpenrouterApiKey() !== undefined
    if (!keyPresent) {
      return { provider, sourceKind: 'none', label: 'OpenRouter usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds OpenRouter' }
    }
    const limitedWindow = (reads?.openrouterLimited ?? openrouterLimitWindow)()
    // The polled key truth (GET /key): the credit figures and the cap meter
    // ride the ONE record; a failed poll with nothing observed is the
    // reader's own labelled line, never a fabricated figure.
    const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
    const figures = openrouterFigures(observed.usage)
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: openrouterObservedWindowViews(reads),
      pools: [],
      credits: openrouterCredits(observed),
      spend,
      tier: API_BILLING_TIER,
      ...(figures.length > 0 ? { figures } : {}),
      ...(observed.usage === null && observed.lastError !== undefined
        ? { readerNote: `credit truth unavailable (${observed.lastError})` }
        : observed.usage !== null && figures.length === 0
          ? { readerNote: 'the key endpoint stated no credit facts' }
          : {}),
      ...(limitedWindow.state === 'limited'
        ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
        : {}),
    }
  }

  if (provider === 'gemini') {
    const account = reads?.geminiAccount ? reads.geminiAccount() : resolveGeminiAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Gemini usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Gemini' }
    }
    const limitedWindow = (reads?.geminiLimited ?? geminiLimitWindow)()
    // No usage endpoint exists on this lane (verified absence —
    // geminiUsageState) — the honest shape is spend + observed limit facts,
    // and the owner carries the absence line every renderer paints.
    return {
      provider,
      sourceKind: account.kind === 'oauth' ? 'oauth' : 'api-key',
      label: account.kind === 'oauth' ? 'Gemini usage' : 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      absence: GEMINI_USAGE_ABSENCE_NOTE,
      // A Google sign-in states no billing tier — the sign-in itself is the
      // honest tier fact; a key is API billing like every key lane.
      tier: account.kind === 'oauth' ? 'Google sign-in' : API_BILLING_TIER,
      ...(limitedWindow.state === 'limited'
        ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
        : {}),
    }
  }

  if (provider === 'huggingface') {
    const account = reads?.huggingfaceAccount ? reads.huggingfaceAccount() : resolveHuggingfaceAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Hugging Face usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Hugging Face' }
    }
    const limitedWindow = (reads?.huggingfaceLimited ?? huggingfaceLimitWindow)()
    // No spend/credit API is documented (huggingfaceUsageState) — the
    // honest shape is the session ledger plus the stated absence; what a
    // response DID state (the draft RateLimit header's remaining count)
    // rides as the one figure this lane has.
    const rate = reads?.huggingfaceRate ? reads.huggingfaceRate() : huggingfaceObservedRate()
    const figures: UsageFigureView[] = rate
      ? [
          {
            key: 'rate-remaining',
            label: 'requests remaining (stated by the last response)',
            value: String(rate.remaining),
            observedAtMs: rate.observedAtMs,
            ...(rate.resetsAtMs !== undefined ? { resetsAtMs: rate.resetsAtMs } : {}),
          },
        ]
      : []
    return {
      provider,
      sourceKind: account.kind === 'oauth' ? 'oauth' : 'api-key',
      label: account.kind === 'oauth' ? 'Hugging Face usage' : 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      ...(figures.length > 0 ? { figures } : {}),
      absence: HUGGINGFACE_USAGE_ABSENCE_NOTE,
      tier: account.kind === 'oauth' ? 'Hugging Face sign-in' : API_BILLING_TIER,
      ...(limitedWindow.state === 'limited' ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } } : {}),
    }
  }

  if (provider === 'local') {
    const account = reads?.localAccount ? reads.localAccount() : resolveLocalAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Local usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'no local server — start one, or set MERCURY_LOCAL_BASE_URL' }
    }
    return {
      provider,
      sourceKind: account.kind === 'keyless' ? 'keyless' : 'api-key',
      label: 'Local usage',
      shape: 'none',
      windows: [],
      pools: [],
      spend,
      absence: 'local · no metering',
      tier: 'local · no metering',
    }
  }

  if (provider === 'moonshot') {
    // The Moonshot family from its OWNING resolver: a Kimi sign-in meters
    // the managed account's stated quota and rate windows (GET /usages —
    // stamped last-observed, empty until answered); a key is API billing
    // with the provider-stated balance (documented unit USD).
    const account = reads?.moonshotAccount ? reads.moonshotAccount() : liveMoonshotAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Moonshot usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins moonshot adds Kimi or a key' }
    }
    if (account.kind === 'kimi-oauth') {
      const managed = reads?.kimiManagedUsage ? reads.kimiManagedUsage() : liveKimiManagedUsage()
      return {
        provider,
        sourceKind: 'oauth',
        label: 'Kimi usage',
        shape: 'subscription-windows',
        windows: kimiManagedWindowViews(managed),
        pools: [],
        spend,
        tier: 'Kimi sign-in',
      }
    }
    const record = reads?.moonshotBalance?.() ?? liveMoonshotBalance()
    const balance = record
      ? { display: `USD ${record.availableBalance}`, observedAtMs: record.observedAtMs }
      : undefined
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: polledBalanceCredits(balance),
      spend,
      tier: API_BILLING_TIER,
      ...(balance ? { balance } : {}),
    }
  }

  // The key-lane families: the same honest
  // api-spend shape as zai, from each family's OWNING resolver; deepseek
  // additionally surfaces its provider-stated balance (a stamped
  // last-observed record — the ONE billing truth its API exposes).
  // (openrouter/gemini return from their rich branches above — the auth
  // fold's dedicated sections own them.)
  if (provider === 'deepseek' || provider === 'openai-compat') {
    const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
    const uncredentialedLabel = provider === 'deepseek' ? 'DeepSeek usage' : 'Endpoint usage'
    if (!credentialed) {
      const whyNot =
        provider === 'deepseek'
          ? 'not connected — /logins deepseek adds a key'
          : 'not configured — set MERCURY_COMPAT_BASE_URL'
      return { provider, sourceKind: 'none', label: uncredentialedLabel, shape: 'none', windows: [], pools: [], spend, whyNot }
    }
    const record = provider === 'deepseek' ? (reads?.deepseekBalance?.() ?? liveDeepseekBalance()) : null
    const primary = record?.balances[0]
    const balance =
      record && primary
        ? { display: `${primary.currency} ${primary.totalBalance}`, observedAtMs: record.observedAtMs }
        : undefined
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      // The balance endpoint is this lane's one credit road; a custom
      // endpoint publishes none this owner reads.
      credits: provider === 'deepseek' ? polledBalanceCredits(balance) : CREDITS_UNREPORTED,
      spend,
      tier: API_BILLING_TIER,
      ...(balance ? { balance } : {}),
      // The provider's own availability word rides beside its balance.
      ...(record && !record.isAvailable
        ? { readerNote: 'the provider marks this account unavailable for inference' }
        : {}),
      // A custom endpoint publishes nothing this owner can read.
      ...(provider === 'openai-compat' ? { absence: COMPAT_USAGE_ABSENCE_NOTE } : {}),
    }
  }

  if (provider === 'unrecognised') {
    // No family declares the session model: no billing source exists to
    // name, and no sign-in door fixes it — the remedy is a listed row.
    return {
      provider,
      sourceKind: 'none',
      label: 'Unrecognised model usage',
      shape: 'none',
      windows: [],
      pools: [],
      spend,
      whyNot: 'no provider family declares the session model — /model picks a listed row',
    }
  }
  const entry = (reads?.activeEntry ?? activeWalletEntry)(provider)
  if (entry === undefined) {
    // The family by its one-owner display name — never a hand-picked
    // two-way vocabulary.
    const title = providerDisplayName(provider)
    const whyNot = `not connected — /logins connects ${title}`
    return { provider, sourceKind: 'none', label: `${title} usage`, shape: 'none', windows: [], pools: [], spend, whyNot }
  }
  if (entry.kind === 'api-key') {
    // Neither first-party key lane publishes a balance road this owner
    // reads — the credits line says so, never a computed spend as a balance.
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      tier: API_BILLING_TIER,
      absence: API_KEY_USAGE_ABSENCE_NOTE,
    }
  }
  if (provider === 'anthropic') {
    // The REAL plan from the OAuth custodian ('max'/'pro'/'team'/'enterprise');
    // a subscriber whose plan word is unstated still names the subscription.
    const plan = (reads?.anthropicPlan ?? getSubscriptionType)()
    return {
      provider,
      sourceKind: 'subscription-oauth',
      label: 'Anthropic usage',
      shape: 'subscription-windows',
      windows: anthropicWindowViews(reads),
      // The per-model weekly pools the endpoint states, beside the pair.
      pools: anthropicPoolWindowViews(reads),
      spend,
      tier: plan ? `Claude ${planWord(plan)}` : 'Claude subscription',
    }
  }
  // This branch is the SUBSCRIPTION source's view (the api-key entry
  // returned above) — its own wall pool, never the key slot's.
  const limitedWindow = (reads?.openaiLimited ?? (() => openaiLimitWindow('chatgpt-subscription')))()
  // The ChatGPT tier from the custodian's own entry fact (identity.plan —
  // openaiAccounts' planType); unstated plan still names the subscription.
  const openaiPlan = entry.identity?.plan
  return {
    provider,
    sourceKind: 'subscription-oauth',
    label: 'OpenAI usage',
    shape: 'subscription-windows',
    windows: openaiWindowViews(reads),
    pools: [],
    spend,
    tier: openaiPlan ? `ChatGPT ${planWord(openaiPlan)}` : 'ChatGPT subscription',
    ...(limitedWindow.state === 'limited' ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } } : {}),
  }
}

/** The one per-provider view. Pure reads; nothing here fires network I/O. */
export function providerUsageView(provider: UsageProvider): ProviderUsageView {
  const entries = walletEntries().filter(e => e.provider === provider)
  const activeEntry = activeWalletEntry(provider)
  if (provider === 'anthropic') {
    return {
      provider,
      ...(activeEntry ? { activeEntry } : {}),
      entries,
      sessionSpend: spendForRoute('anthropic'),
      limits: { kind: 'anthropic-windows', status: currentLimits.status, raw: getRawUtilization() },
    }
  }
  return {
    provider,
    ...(activeEntry ? { activeEntry } : {}),
    entries,
    sessionSpend: spendForRoute('openai'),
    // The ACTIVE entry's own wall pool (per-source records) — an absent
    // entry has no pool to consult.
    limits: {
      kind: 'openai-observed',
      window: openaiLimitWindow(activeEntry?.kind === 'api-key' ? 'api-key' : 'chatgpt-subscription'),
    },
  }
}
