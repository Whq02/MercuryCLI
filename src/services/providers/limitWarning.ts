// ============================================================================
//  providers/limitWarning — the ONE approaching-limit warning derivation
//  (usage-breadth lane, operator-ruled).
//
//  THE LAW: the yellow strip warning fires for WHICHEVER provider the
//  session actually runs on, from that provider's OWN signals — never only
//  the Anthropic subscription meters, and never a fabricated meter for a
//  provider whose wire serves no usage signal (capability honesty: an
//  absent signal is an absent warning, not a 0%).
//
//  One owner (this module), per-provider feeders, one copy grammar:
//
//      "<provider>: XX% of <window> used[ · resets <t>]"
//
//  The reset tail rides exactly when the provider stated a reset — the same
//  optional-clause composition every provider shares. The renderer (the
//  rate-limit-warning notification) keeps the one yellow token; this module
//  owns only the words and the decision.
//
//  Feeders, per family (the signal each wire actually serves):
//    · anthropic  — TWO feeders of one store: the claudeAiLimits header
//                   record (the anthropic-ratelimit-unified-* states,
//                   per-family claims included: session · weekly · Opus ·
//                   Sonnet · Fable · extra usage; the existing
//                   allowed_warning + utilization≥0.7 gate), and the window
//                   METERS — the 5h/7d pair (headers first, the subscription
//                   usage endpoint filling absence) AND the per-model weekly
//                   POOL of the session model's own family (the endpoint
//                   states Fable · Opus · Sonnet; only the model's pool
//                   binds it) — at the shared threshold, the BINDING window
//                   named in the wire's own claim vocabulary ("Anthropic:
//                   99% of Fable limit used");
//    · openai     — the observed x-codex usage bands (openaiLimitState);
//    · openrouter — the polled per-key credit cap (openrouterUsageState —
//                   the 402/exhaustion honesty exists on the dispatch path;
//                   THIS adds the approaching tier);
//    · moonshot (Kimi sign-in) — the managed account's stated quota/rate
//                   windows (moonshotUsageState);
//    · every other lane serves NO percent-shaped usage signal (gemini —
//      verified endpoint absence; huggingface — documented absence; local —
//      no metering; zai · compat — nothing; deepseek · moonshot key —
//      balance only, no denominator) ⇒ null, honestly.
//
//  Every meter feeder reads the ONE binding-window pick the usage owner
//  attaches to the active-source view (providerUsage.bindingWindowOf — the
//  same derivation the settings tab, the rail meters, the frame band and
//  the cap offer read), so the strip warning, the offer and the meters can
//  never name different windows or disagree about a percent.
// ============================================================================
import { formatResetTime } from '../../utils/format.js'
import { currentLimits, type ClaudeAILimits } from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { providerDisplayName } from './routeLaw.js'
import { activeSourceUsage, type ActiveUsageReads, type UsageWindowView } from './providerUsage.js'

/** The approaching threshold, one spelling for every lane: the Anthropic
 *  warning gate (utilization ≥ 0.7) and the Usage tab's WARN_PCT band. */
export const APPROACHING_LIMIT_PCT = 70

export interface ProviderLimitWarningView {
  /** The route the session runs on (the routing law's answer). */
  provider: string
  /** The one operator-facing line, grammar-composed. */
  text: string
}

/** Injectable reads for provers; production callers pass nothing. */
export interface LimitWarningReads extends ActiveUsageReads {
  /** The anthropic limits record (the live singleton otherwise). */
  anthropicLimits?: () => ClaudeAILimits
}

/** The optional reset tail — present exactly when the provider stated one. */
function resetTail(epochSeconds: number | undefined): string {
  const rendered = formatResetTime(epochSeconds)
  return rendered !== undefined ? ` · resets ${rendered}` : ''
}

/** The one grammar, every provider: "<provider>: XX% of <window> used". */
function composeLine(provider: string, pct: number, window: string, resetsAtSeconds?: number): string {
  return `${provider}: ${pct}% of ${window} used${resetTail(resetsAtSeconds)}`
}

/**
 * The anthropic HEADER feeder — the SAME decision the pre-breadth strip
 * made (status allowed_warning, the utilization<0.7 mute, the no-claim
 * mute, the overage-close special case), re-worded into the one grammar.
 * The wire's own warning vocabulary carries the per-family claims (the
 * Fable/Opus/Sonnet weekly pools) — nothing else does. The error path
 * (status rejected) stays with the API-error surfaces; a reached limit is
 * a refusal, not a warning.
 */
function anthropicWarning(limits: ClaudeAILimits): ProviderLimitWarningView | null {
  const provider = providerDisplayName('anthropic')
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      // The spending-cap warning has no percent on the wire — the state IS
      // the signal; the copy keeps the pre-breadth spelling (a spend cap is
      // not a window meter, so the % grammar honestly cannot apply).
      return {
        provider: 'anthropic',
        text: 'Anthropic says this account is close to its extra usage spending limit',
      }
    }
    return null
  }
  if (limits.status !== 'allowed_warning') return null
  if (limits.utilization !== undefined && limits.utilization < APPROACHING_LIMIT_PCT / 100) return null
  const claim = limits.rateLimitType
  if (claim === undefined) return null
  const window = claim === 'overage' ? 'extra usage limit' : rateLimitWindowName(claim)
  const pct = limits.utilization !== undefined ? Math.floor(limits.utilization * 100) : 0
  // A floored 0 has no honest percent to speak — the approaching wording
  // stands in (the pre-breadth fall-through, one grammar's voice).
  const text =
    pct > 0
      ? composeLine(provider, pct, window, limits.resetsAt)
      : `${provider}: approaching ${window}${resetTail(limits.resetsAt)}`
  return { provider: 'anthropic', text }
}

/**
 * THE derivation: the session's model decides the lane (the routing law);
 * the lane's own observed signal decides whether a warning exists. Pure
 * reads; no network I/O; total over every route.
 */
export function providerLimitWarning(opts?: {
  model?: string
  reads?: LimitWarningReads
}): ProviderLimitWarningView | null {
  const reads = opts?.reads
  // The active-source view answers route + source + the window views in one
  // derivation (the same one the meters render). Guarded: a warning must
  // never crash a paint.
  let view: ReturnType<typeof activeSourceUsage>
  try {
    view = activeSourceUsage({
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(reads !== undefined ? { reads } : {}),
    })
  } catch {
    return null
  }

  if (view.provider === 'anthropic') {
    // Subscription windows only: an active Anthropic API key has no
    // subscription meters (shape api-spend serves no percent) — honest
    // nothing, exactly the pre-breadth subscriber gate.
    if (view.shape !== 'subscription-windows') return null
    const limits = reads?.anthropicLimits?.() ?? currentLimits
    const fromHeaders = anthropicWarning(limits)
    if (fromHeaders !== null) return fromHeaders
    // THE METER FEEDER (the operator's ruled signal set: "the existing
    // meters"): the 5h/7d window views — response headers first, the
    // subscription usage endpoint filling absence (the one claudeAiLimits
    // record) — AND the per-model weekly pool of the session model's own
    // family (the endpoint states Fable · Opus · Sonnet beside the pair;
    // the headers never carry them as a warning claim) — warn at the same
    // threshold as every lane, the BINDING window named in the wire's own
    // claim vocabulary so one window never has two names: Fable at 99%
    // beside a calm all-models week paints "99% of Fable limit used" for a
    // Fable session, and nothing for a Sonnet session the Fable week never
    // caps. The pick is the usage owner's (view.binding), shared with the
    // meters and the cap offer.
    const binding = view.binding
    if (binding === undefined) return null
    const pct = flooredPct(binding.window)
    if (pct < APPROACHING_LIMIT_PCT) return null
    const window = binding.claim !== undefined ? rateLimitWindowName(binding.claim) : binding.windowName
    return {
      provider: 'anthropic',
      text: composeLine(providerDisplayName('anthropic'), pct, window, resetSecondsOf(binding.window)),
    }
  }

  // Engine lanes: the binding (worst provider-stated percent) window. A
  // lane whose wire stated nothing has no windows here — and therefore no
  // warning.
  const binding = view.binding
  if (binding === undefined) return null
  const pct = flooredPct(binding.window)
  if (pct < APPROACHING_LIMIT_PCT) return null
  // The provider word: the active source's own label where it names one
  // (Kimi sign-in says Kimi), else the family's display name.
  const label = view.label
  const word =
    label.endsWith(' usage') && label !== 'API usage'
      ? label.slice(0, -' usage'.length)
      : providerDisplayName(view.provider)
  return {
    provider: view.provider,
    text: composeLine(word, pct, binding.windowName, resetSecondsOf(binding.window)),
  }
}

/**
 * THE PRECEDENCE LAW for a daemon-hosted chat: the focused session's runner makes the model requests, so the
 * per-turn feeders — the Anthropic header states, the OpenAI x-codex
 * bands, the OpenRouter/Kimi probe refreshes its dispatch fires — are
 * observed in ITS process and answered inside session_facts
 * (UsageFactsV1.limitWarning); this screen's stores see only the /usage
 * mount and the boot probe. A runner fact wins; a null one (the runner
 * sees no warning) or an absent one (an older runner, no facts yet, the
 * resting slot) falls to the screen's own derivation — the endpoint pools
 * the /usage mount folded here are observations the runner never made.
 */
export function preferSessionLimitWarning(
  fromSession: ProviderLimitWarningView | null | undefined,
  local: ProviderLimitWarningView | null,
): ProviderLimitWarningView | null {
  return fromSession ?? local
}

function flooredPct(view: UsageWindowView): number {
  return Math.floor(Math.min(100, Math.max(0, view.usedPct ?? 0)))
}

function resetSecondsOf(view: UsageWindowView): number | undefined {
  return view.resetsAtMs !== undefined ? Math.floor(view.resetsAtMs / 1000) : undefined
}
