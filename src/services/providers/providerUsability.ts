// ============================================================================
//  providers/providerUsability — THE provider-usability resolver (
//  R06; Rider 2 / R5).
//
//  ONE composed answer to "can this provider take work right now, and if
//  not, why" — credential + catalogue + live limit state — built strictly
//  OVER the existing owners (never a second credential store):
//    · anthropic — auth.ts credential truth (subscriber OAuth / API key) +
//      the observed live limit state (services/claudeAiLimits currentLimits),
//      with DEGRADATION HONESTY: a capped window also caps Claude-backed
//      delegation (delegation is NOT a failover candidate — Rider 2 names
//      subagent multi-provider a non-goal);
//    · openai — getGptSeatAvailability() (account + live catalogue
//      qualification, typed reasons — the composed owner);
//    · zai — ZAI_API_KEY presence.
//
//  Consumers (the R06 row): the transition planner (plan.targetUsability →
//  the preview card's warn row — live today), the entry/logins router and
//  the cap offer card (R02/R04 wire the same read), capability surfaces.
//  Reads are injectable for hermetic proof (the settleModelSelection
//  injected-gates precedent); the live bundle is the default.
// ============================================================================
import { getAnthropicApiKey, isClaudeAISubscriber } from '../../utils/auth.js'
import { currentLimits } from '../claudeAiLimits.js'
import { getGptSeatAvailability } from './openai/openaiCatalogue.js'
import { providerDisplayName } from './routeLaw.js'

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

export interface ProviderUsability {
  /** 'unrecognised' rides only the synthetic not-usable answer for an id no
   *  family declares (usabilityForRoute's honest arm). */
  provider: ProviderId | 'unrecognised'
  /** How the provider is credentialed, from the OWNING store ('keyless':
   *  a reachable local server that takes none). */
  credential: 'oauth' | 'api-key' | 'keyless' | 'none'
  /** Live limit state — the claudeAiLimits latch for anthropic; the non-Anthropic
   *  lanes surface limits per-request today ('unknown'). */
  limit: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'
  usable: boolean
  /** Typed, operator-readable blockers (empty when usable). */
  blockers: string[]
  /** Anthropic only — degradation honesty: a capped window also caps
   *  Claude-backed delegation (subagents are NOT failover candidates). */
  delegationCapped?: boolean
}

export interface ProviderUsabilityReads {
  anthropicApiKey: () => string | null
  anthropicSubscriber: () => boolean
  /** An env bearer token the API client would send (ANTHROPIC_AUTH_TOKEN
   *  and the OAuth-token env spellings) — the presence owner's own rule
   *  (providerUsage.anthropicCredentialPresence); optional so existing
   *  fixtures stand. */
  anthropicBearerToken?: () => boolean
  anthropicLimitStatus: () => 'allowed' | 'allowed_warning' | 'rejected'
  gptSeat: () => { state: 'ready' | 'disabled'; reason?: string; why?: string }
  zaiKeyPresent: () => boolean
  /** Provider-08-21 (optional so existing prover fixtures stand):
   *  key/config presence per new lane; live defaults read the owning
   *  resolvers. */
  /** The Moonshot family's account from its OWNING resolver (a Kimi sign-in
   *  or a key) — kind only, never a value. */
  moonshotAccount?: () => { kind: 'kimi-oauth' | 'api-key' } | undefined
  deepseekKeyPresent?: () => boolean
  compatConfigured?: () => boolean
  /** The compat slot's OWN account view (FC-075): kind decides the
   *  credential word the readiness lane shows; optional so standing
   *  fixtures (compatConfigured alone) keep the historical shape. */
  compatAccount?: () => { kind: 'api-key' | 'keyless' } | undefined
  huggingfaceAccount?: () => { kind: 'oauth' | 'api-key' } | undefined
  localServerPresent?: () => boolean
  /** Fold landed: openrouter/gemini answer from their OWNING
   *  account resolvers like every landed family — the runtime-pending
   *  tombstone died with the fold it described. */
  openrouterKeyPresent?: () => boolean
  geminiAccount?: () => { kind: 'oauth' | 'api-key' } | undefined
  /** Spec-05 usage truth: the engine lanes' LAST-OBSERVED limit windows
   *  (each family's own latch module). 'limited' while an observed reset is
   *  ahead ⇒ the lane's limit axis reads REJECTED (blocks work + delegated
   *  dispatch); 'clear' stays 'unknown' — no headroom is ever invented. */
  openaiLimitWindow?: () => { state: 'limited' | 'clear' }
  openrouterLimitWindow?: () => { state: 'limited' | 'clear' }
  geminiLimitWindow?: () => { state: 'limited' | 'clear' }
  huggingfaceLimitWindow?: () => { state: 'limited' | 'clear' }
  /** The HF lane's observed billing refusal (no credit API exists — a live
   *  402 is the one knowable fact; a 2xx clears it at the same owner). */
  huggingfaceBillingState?: () => { state: 'credit-exhausted' | 'clear' }
  /** Every OTHER lane's observed billing refusal (laneBillingState — the
   *  runtimes record a wire-refused billing fault with the lane's own
   *  remedy; a settled turn clears it). */
  laneBillingState?: (
    lane: ProviderId,
  ) => { state: 'credit-exhausted'; detail: string; remedy: string } | { state: 'clear' }
}

/** The live read bundle — every field reads its OWNING store. Module-
 *  private since the zero-reference adjudication: it is the
 *  resolver's default; the /status parity target it was exported for
 *  landed through the wallet facade (services/wallet) instead. */
function liveProviderUsabilityReads(): ProviderUsabilityReads {
  return {
    anthropicApiKey: () => {
      try {
        return getAnthropicApiKey()
      } catch {
        // The no-credential environments THROW here (the CI/test refusal in
        // utils/auth) — the usability map reads that as an absent key, the
        // presence owner's own law (providerUsage.anthropicCredentialPresence):
        // a refusing custodian never crashes the derived surfaces, and the
        // other families' verdicts still answer.
        return null
      }
    },
    anthropicSubscriber: () => isClaudeAISubscriber(),
    anthropicBearerToken: () => {
      const { anthropicCredentialPresence } =
        require('./providerUsage.js') as typeof import('./providerUsage.js')
      return anthropicCredentialPresence({
        claudeSubscriber: () => false,
        anthropicApiKeyPresent: () => false,
      }).credentialed
    },
    anthropicLimitStatus: () => currentLimits.status,
    gptSeat: () => getGptSeatAvailability(),
    // The OWNING resolver (env, then the auth-scoped store) — an env-only
    // read painted a key stored via /router key as "no Z.AI API key" while
    // every dispatch on that key succeeded.
    zaiKeyPresent: () => {
      const { resolveZaiApiKey } =
        require('../../utils/router/providerDiscovery.js') as typeof import('../../utils/router/providerDiscovery.js')
      return resolveZaiApiKey() !== undefined
    },
    moonshotAccount: () => {
      const { resolveMoonshotAccount } =
        require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
      return resolveMoonshotAccount()
    },
    deepseekKeyPresent: () => {
      const { resolveDeepseekApiKey } =
        require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
      return resolveDeepseekApiKey() !== undefined
    },
    compatConfigured: () => {
      const { resolveCompatSlotConfig } =
        require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
      return resolveCompatSlotConfig() !== undefined
    },
    compatAccount: () => {
      const { resolveCompatAccount } =
        require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
      return resolveCompatAccount()
    },
    huggingfaceAccount: () => {
      const { resolveHuggingfaceAccount } =
        require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')
      return resolveHuggingfaceAccount()
    },
    localServerPresent: () => {
      const { resolveLocalAccount } =
        require('./local/localAccounts.js') as typeof import('./local/localAccounts.js')
      return resolveLocalAccount() !== undefined
    },
    openrouterKeyPresent: () => {
      const { resolveOpenrouterApiKey } =
        require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')
      return resolveOpenrouterApiKey() !== undefined
    },
    geminiAccount: () => {
      const { resolveGeminiAccount } =
        require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
      return resolveGeminiAccount()
    },
    openaiLimitWindow: () => {
      // The ACTIVE source's own window (the walls are per-source pools —
      // a subscription wall must not refuse work on the key slot's own
      // billing, nor the reverse). No account resolved ⇒ no window.
      const { openaiLimitWindow } =
        require('./openai/openaiLimitState.js') as typeof import('./openai/openaiLimitState.js')
      const { resolveOpenaiAccount } =
        require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      const active = resolveOpenaiAccount()
      return active === undefined ? { state: 'clear' } : openaiLimitWindow(active.kind)
    },
    openrouterLimitWindow: () => {
      const { openrouterLimitWindow } =
        require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
      return openrouterLimitWindow()
    },
    geminiLimitWindow: () => {
      const { geminiLimitWindow } =
        require('./gemini/geminiUsageState.js') as typeof import('./gemini/geminiUsageState.js')
      return geminiLimitWindow()
    },
    huggingfaceLimitWindow: () => {
      const { huggingfaceLimitWindow } =
        require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
      return huggingfaceLimitWindow()
    },
    huggingfaceBillingState: () => {
      const { huggingfaceBillingState } =
        require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
      return huggingfaceBillingState()
    },
    laneBillingState: lane => {
      const { laneBillingState } =
        require('./laneBillingState.js') as typeof import('./laneBillingState.js')
      return laneBillingState(lane)
    },
  }
}

export function resolveProviderUsability(
  reads: ProviderUsabilityReads = liveProviderUsabilityReads(),
): Record<ProviderId, ProviderUsability> {
  // ── anthropic ─────────────────────────────────────────────────────────────
  const subscriber = reads.anthropicSubscriber()
  const key = reads.anthropicApiKey()
  // The env bearer token is an OAuth-shaped credential the wire accepts —
  // the presence owner counts it, so this resolver does too (one answer
  // for /accounts, /model, /health and the transition preview).
  const bearer = reads.anthropicBearerToken?.() ?? false
  const anthropicCredential: ProviderUsability['credential'] = subscriber
    ? 'oauth'
    : key
      ? 'api-key'
      : bearer
        ? 'oauth'
        : 'none'
  const limit = anthropicCredential === 'none' ? 'unknown' : reads.anthropicLimitStatus()
  const anthropicBlockers: string[] = []
  if (anthropicCredential === 'none') {
    anthropicBlockers.push('no Anthropic credential — /logins (or ANTHROPIC_API_KEY)')
  }
  if (limit === 'rejected') {
    anthropicBlockers.push('the Anthropic usage window is reached — resets per /usage')
  }
  const anthropic: ProviderUsability = {
    provider: 'anthropic',
    credential: anthropicCredential,
    limit,
    usable: anthropicBlockers.length === 0,
    blockers: anthropicBlockers,
    // Degradation honesty: Claude-backed delegation shares the window.
    delegationCapped: limit === 'rejected',
  }

  // ── openai (the composed owner already speaks typed reasons) ─────────────
  const seat = reads.gptSeat()
  const openaiBlockers: string[] = []
  if (seat.state !== 'ready') openaiBlockers.push(seat.reason ?? 'GPT lane unavailable')
  // Credential-axis spelling for the entry surfaces: the seat owner's TYPED
  // why when it carries one (no-account and auth-expired are both credential
  // absences), else the reason-string fallback (older fixtures).
  const seatCredentialAbsent =
    seat.state !== 'ready' &&
    (seat.why === 'no-account' ||
      seat.why === 'auth-expired' ||
      (seat.why === undefined && (seat.reason ?? '').includes('no OpenAI account')))
  const openai: ProviderUsability = {
    provider: 'openai',
    credential: seatCredentialAbsent ? 'none' : 'oauth',
    limit: 'unknown',
    usable: seat.state === 'ready',
    blockers: openaiBlockers,
  }

  // ── zai ──────────────────────────────────────────────────────────────────
  const zaiKey = reads.zaiKeyPresent()
  const zaiBlockers: string[] = []
  if (!zaiKey) zaiBlockers.push('no Z.AI API key — /logins zai (or ZAI_API_KEY)')
  const zai: ProviderUsability = {
    provider: 'zai',
    credential: zaiKey ? 'api-key' : 'none',
    limit: 'unknown',
    usable: zaiBlockers.length === 0,
    blockers: zaiBlockers,
  }

  // ── the key lanes ───────
  const keyLane = (
    provider: ProviderId,
    present: boolean,
    blocker: string,
    credential: ProviderUsability['credential'] = 'api-key',
  ): ProviderUsability => ({
    provider,
    credential: present ? credential : 'none',
    limit: 'unknown',
    usable: present,
    blockers: present ? [] : [blocker],
  })
  const moonshotAccount = reads.moonshotAccount?.()
  const moonshot = keyLane(
    'moonshot',
    moonshotAccount !== undefined,
    'no Kimi sign-in or Moonshot API key — /logins moonshot (or MOONSHOT_API_KEY)',
    moonshotAccount?.kind === 'kimi-oauth' ? 'oauth' : 'api-key',
  )
  const deepseek = keyLane(
    'deepseek',
    reads.deepseekKeyPresent?.() ?? false,
    'no DeepSeek API key — /logins deepseek (or DEEPSEEK_API_KEY)',
  )
  // The slot's OWN key resolver decides the credential word (FC-075): the
  // readiness lane defaulted to the key lane's 'api-key' while /status,
  // /config and doctor called the same keyless slot keyless on the same
  // boot. compatConfigured stays as the presence fallback for standing
  // fixtures.
  const compatAccount = reads.compatAccount?.()
  const compat = keyLane(
    'openai-compat',
    compatAccount !== undefined || (reads.compatConfigured?.() ?? false),
    'no endpoint configured — MERCURY_COMPAT_BASE_URL',
    compatAccount?.kind === 'keyless' ? 'keyless' : 'api-key',
  )

  const huggingfaceAccount = reads.huggingfaceAccount?.()
  const huggingface = keyLane(
    'huggingface',
    huggingfaceAccount !== undefined,
    'no Hugging Face credential — /logins (or HF_TOKEN)',
    huggingfaceAccount?.kind === 'oauth' ? 'oauth' : 'api-key',
  )
  const local = keyLane(
    'local',
    reads.localServerPresent?.() ?? false,
    'no local server discovered — start Ollama/LM Studio/vLLM/llama.cpp-server or set MERCURY_LOCAL_BASE_URL',
    'keyless',
  )

  // The fold landed (openrouter/gemini dispatch live on the shared compat
  // runtime): presence from each family's OWNING resolver, the key-lane
  // shape — the runtime-pending tombstone died with the fold it described.
  const openrouter = keyLane(
    'openrouter',
    reads.openrouterKeyPresent?.() ?? false,
    'no OpenRouter credential — /logins (or OPENROUTER_API_KEY)',
  )
  const geminiAccount = reads.geminiAccount?.()
  const gemini = keyLane(
    'gemini',
    geminiAccount !== undefined,
    'no Gemini credential — /logins (or GOOGLE_API_KEY / GEMINI_API_KEY)',
    geminiAccount?.kind === 'oauth' ? 'oauth' : 'api-key',
  )

  // Spec-05 usage truth: an engine lane with an OBSERVED live limit window
  // (its own latch; 'limited' only while the reset is ahead) reads
  // limit=rejected — blocking work and delegated dispatch — with the window
  // blocker beside the lane's own facts. A 'clear' latch stays 'unknown':
  // no headroom is ever invented (absence ≠ 100%).
  const applyObservedLimit = (
    lane: ProviderUsability,
    window: { state: 'limited' | 'clear' } | undefined,
  ): ProviderUsability => {
    if (window?.state !== 'limited' || lane.credential === 'none') return lane
    return {
      ...lane,
      limit: 'rejected',
      usable: false,
      blockers: [
        ...lane.blockers,
        `the ${lane.provider} usage window is reached — resets per /usage`,
      ],
    }
  }
  // A lane whose wire refused the last turn for credit exhaustion is not
  // usable, and the row says so — 'ready' over a credit-dead wire is a lie.
  // The observation clears at its owner on the next successful response.
  const applyObservedBilling = (
    lane: ProviderUsability,
    billing: { state: 'credit-exhausted' | 'clear' } | undefined,
  ): ProviderUsability => {
    if (billing?.state !== 'credit-exhausted' || lane.credential === 'none') return lane
    return {
      ...lane,
      usable: false,
      blockers: [
        ...lane.blockers,
        'Inference Providers credits exhausted (the wire refused with 402) — top up at huggingface.co/settings/billing; a successful turn clears this',
      ],
    }
  }

  // The same law for every other lane, from the ONE runtime-fed owner
  // (laneBillingState): a wire that refused the last turn for credit —
  // 402, Z.AI's balance code, an "insufficient balance" word — makes the
  // lane not usable, and the blocker carries the lane's own documented
  // remedy; the next settled turn clears it.
  const applyLaneBilling = (lane: ProviderUsability): ProviderUsability => {
    if (lane.provider === 'unrecognised') return lane // no lane, no billing state
    const billing = reads.laneBillingState?.(lane.provider)
    if (billing?.state !== 'credit-exhausted' || lane.credential === 'none') return lane
    return {
      ...lane,
      usable: false,
      blockers: [
        ...lane.blockers,
        `the ${lane.provider} wire refused the last turn for billing (${billing.detail}) — ${billing.remedy} A successful turn clears this.`,
      ],
    }
  }

  return {
    anthropic,
    openai: applyLaneBilling(applyObservedLimit(openai, reads.openaiLimitWindow?.())),
    zai: applyLaneBilling(zai),
    moonshot: applyLaneBilling(moonshot),
    deepseek: applyLaneBilling(deepseek),
    'openai-compat': applyLaneBilling(compat),
    openrouter: applyLaneBilling(applyObservedLimit(openrouter, reads.openrouterLimitWindow?.())),
    gemini: applyLaneBilling(applyObservedLimit(gemini, reads.geminiLimitWindow?.())),
    huggingface: applyObservedBilling(
      applyObservedLimit(huggingface, reads.huggingfaceLimitWindow?.()),
      reads.huggingfaceBillingState?.(),
    ),
    local: applyLaneBilling(local),
  }
}

/** The boot honesty notice for a session with NO Anthropic credential and
 *  at least one usable engine lane — capability-derived from the resolver
 *  truth, null when it does not apply. It LEADS with the lanes that ARE
 *  working (the session's own family is the unmarked case on a sovereign
 *  home, never the absent one) and then names the Claude-ACCOUNT surfaces
 *  that stay dormant (the /usage windows); everything else — tools,
 *  subagents (they ride the session's own family through the routed
 *  dispatch), workflows — runs on the usable lane. Fires for every family
 *  alike: an OpenRouter-only boot gets the same honesty an OpenAI-only boot
 *  does. Pure over the resolved map (hermetic proof feeds fixtures). */
export function nonAnthropicBootNotice(
  map: Record<ProviderId, ProviderUsability> = resolveProviderUsability(),
): string | null {
  if (map.anthropic.credential !== 'none') return null
  const usable = (Object.values(map) as ProviderUsability[])
    .filter(lane => lane.provider !== 'anthropic' && lane.usable)
    .map(lane => providerDisplayName(lane.provider))
  if (usable.length === 0) return null
  return (
    `${usable.join(', ')} ${usable.length === 1 ? 'is' : 'are'} the working lane${usable.length === 1 ? '' : 's'}: ` +
    'tools, subagents and workflows run on the session\'s own family. ' +
    'No Anthropic credential — the Claude-account surfaces (the Anthropic usage windows) stay dormant; /logins adds one any time.'
  )
}

/** The one-provider view for a resolved call route (planner/card use).
 *  'unrecognised' answers the honest not-usable view — no lane exists for
 *  an id no family declares, and no lane's state is borrowed for it. */
export function usabilityForRoute(
  route: ProviderId | 'unrecognised',
  reads?: ProviderUsabilityReads,
): ProviderUsability {
  if (route === 'unrecognised') {
    return {
      provider: 'unrecognised',
      credential: 'none',
      limit: 'unknown',
      usable: false,
      blockers: ['no provider family declares the target id — /model picks a listed row'],
    }
  }
  return resolveProviderUsability(reads)[route]
}

/**
 * Usage-aware dispatch: the delegation-dispatch
 * verdict for a resolved call route — null when the lane can take delegated
 * work, else ONE honest refusal string naming the blockers and the lanes
 * that ARE usable right now. Delegated agents are never silently rerouted
 * across providers (multi-provider subagents are a named non-goal — the
 * Rider 2 law this module already states); the refusal informs the DECIDER
 * (model or operator), who picks a usable lane explicitly. Pure over the
 * resolved map so the proof injects fixtures.
 *
 * The verdict rides the LIMIT axis only: anthropic blocks on
 * `delegationCapped` (a rejected window caps Claude-backed delegation —
 * live header truth via the limits latch); the engine lanes block on an observed
 * rejected window when their resolvers ever feed one (today 'unknown' ⇒
 * never). Credential absences are deliberately not preflighted —
 * they fail fast at the provider call. Last-observed semantics: before any
 * rejection is observed the lane reads usable and the dispatch proceeds —
 * after one observed rejection every subsequent dispatch refuses instantly
 * without burning a request, until the window resets.
 */
export function delegationDispatchBlocker(
  route: ProviderId,
  map: Record<ProviderId, ProviderUsability> = resolveProviderUsability(),
): string | null {
  const lane = map[route]
  // The LIMIT axis only — the live-observed window truth. A lane whose
  // window is REJECTED refuses delegated work (anthropic: the resolver's
  // own delegationCapped field). Credential absences are NOT
  // preflighted: those dispatches already fail fast and honestly at the
  // provider call itself, and hermetic proof rigs legitimately run
  // credential-less against fixture endpoints — a credential preflight
  // would refuse work the fixture would serve.
  const blocked =
    route === 'anthropic'
      ? lane.delegationCapped === true
      : lane.limit === 'rejected'
  if (!blocked) return null
  const usableAlternatives = (Object.values(map) as ProviderUsability[])
    .filter(p => p.provider !== route && p.usable)
    .map(p => p.provider)
  const why = lane.blockers.length > 0 ? lane.blockers.join('; ') : 'lane unavailable'
  const alternatives =
    usableAlternatives.length > 0
      ? ` Lanes with usage right now: ${usableAlternatives.join(', ')} — dispatch there by naming a model explicitly (the Agent model parameter).`
      : ' No other lane is usable right now — wait for the window to reset.'
  return (
    `the ${route} lane cannot take delegated work right now (${why}). ` +
    `Delegated agents are never silently rerouted across providers.` +
    alternatives
  )
}
