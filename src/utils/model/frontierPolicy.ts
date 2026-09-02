// =============================================================================
// model/frontierPolicy.ts — the ONE frontier-operator decision of the
// FIRST-PARTY family
//
// Decides which first-party row a credential can use as that family's
// frontier: the highest-priority registered frontier entry whose
// account/allowlist rules are satisfied wins; otherwise the deterministic
// Opus fallback stands, with a terse diagnostic code. This is ONE family's
// gating among equals (the neutral-default ruling): the session
// default is the computed default (computedDefault.ts — the newest usable
// row of the provider of the most recent sign-in), which consumes THIS
// decision for the first-party lane exactly as it reads the picker's gating
// for every other family. The `best` alias and the first-party rows' copy
// (/model, /health's first-party detail) project it; none re-derive it.
//
// Shape: a PURE evaluator over a typed facts record (the provable core — the
// scripts/model-policy/ matrix drives it with injected facts, per the F6
// ambient-state law) plus a thin live gatherer that reads the EXISTING owners
// (env, cached OAuth account facts, settings). No network, no writes, no new
// stores.
//
// Scope law:
//   · Only the final built-in-default rung moves. Explicit selections
//     (session /model, --model, ANTHROPIC_MODEL, settings.model), resumed
//     conversations, and every deliberately tuned supporting role (crew
//     seats, workflow executors) keep their own resolvers byte-for-byte.
//   · A later frontier model becomes preferred when the OPERATOR names it
//     (the env pin, the settings model, an allowlist naming the family) or
//     when a ratified default owner changes by hand — never by an
//     anticipatory registration table, and never by name/date guessing. A
//     surprise release must not silently replace the operator's foreground.
//   · Eligibility is evidence-shaped, not label-shaped: the first-party
//     Claude-subscription rung requires the CONFIRMED Max 20x rate-limit tier
//     (`default_claude_max_20x`) — a generic "max" label is NOT enough. The
//     pre-existing explicit signals (ANTHROPIC_DEFAULT_FABLE_MODEL env pin,
//     a local availableModels entry naming the family) stay honored.
//   · availableModels PRESENT-and-excluding is a real exclusion; ABSENT is
//     not (absence ≠ exclusion). No new network request — every fact here is
//     already local.
// =============================================================================

import {
  getRateLimitTier,
  isClaudeAISubscriber,
  isMaxSubscriber,
} from '../auth.js'
import { is1mContextDisabled } from './capabilities.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

// Deliberate late imports through model.js live bindings (runtime-only cycle,
// same pattern modelFloor.ts documents): both sides call at call-time, never at
// module load.
import {
  getDefaultFableModel,
  getDefaultOpusModel,
  isDefaultOpusNatively1M,
  isOpus1mMergeEnabled,
} from './model.js'

/** The confirmed Max 20x rate-limit tier — the launch eligibility fact. */
export const FRONTIER_MAX_20X_TIER = 'default_claude_max_20x'

/**
 * Terse, stable eligibility codes — the projection vocabulary for picker copy,
 * /health and the truth table. `eligible-*` codes are the reason a
 * candidate QUALIFIED; the rest are the reason it did not.
 */
export type FrontierEligibilityCode =
  | 'eligible-env-pin' // ANTHROPIC_DEFAULT_FABLE_MODEL — explicit operator signal
  | 'eligible-allowlist' // local availableModels names the family — explicit signal
  | 'eligible-max-20x' // confirmed Max 20x first-party subscription path
  | 'not-subscriber' // no Claude.ai OAuth subscription facts
  | 'not-max' // subscription is not Max
  | 'unknown-rate-limit-tier' // Max, but no rate-limit tier fact — never guess 20x
  | 'not-20x' // Max, but a non-20x tier
  | 'allowlist-excluded' // availableModels present and excludes the model

/** One registered frontier candidate with its evaluated verdict. */
export type FrontierCandidateVerdict = {
  /** Resolved current model id for this entry (env pin honored for Fable). */
  id: string
  /** Family key, e.g. 'fable'. */
  family: string
  /** Deterministic preference rank — higher wins. */
  rank: number
  eligible: boolean
  code: FrontierEligibilityCode
}

/** The one frontier-operator decision. */
export type FrontierOperatorDecision = {
  /**
   * The model-SETTING string a fresh unpinned foreground session resolves —
   * carries `[1m]` when the winning entry's default context rides the suffix
   * (Fable 5's 1M is API-granted, not an extra-usage billing tier).
   */
  setting: string
  source: 'frontier' | 'fallback'
  /** The winning candidate when source === 'frontier'. */
  winner: FrontierCandidateVerdict | null
  /** Every registered candidate, rank-descending, each with its verdict. */
  candidates: FrontierCandidateVerdict[]
  /**
   * Terse projection code: the winner's eligibility code, or — on fallback —
   * the leading candidate's failure code (the operator-facing "why not").
   */
  code: FrontierEligibilityCode | 'no-registered-candidate'
}

/**
 * The typed facts the PURE evaluator consumes — gathered from the existing
 * owners live, or injected verbatim by the scripts/model-policy/ proof matrix.
 */
export type FrontierFacts = {
  /** ANTHROPIC_DEFAULT_FABLE_MODEL — set ⇒ explicit signal + verbatim id. */
  fableEnvPin: boolean
  /** The resolved current Fable id (env pin honored). */
  fableId: string
  /** settings.availableModels is PRESENT (absence is never exclusion). */
  allowlistPresent: boolean
  /** The local allowlist names the fable family (explicit opt-in signal). */
  allowlistNamesFable: boolean
  /** Allowlist verdict for a concrete id (isModelAllowed semantics). */
  allowlistPermits: (id: string) => boolean
  claudeAiSubscriber: boolean
  maxSubscriber: boolean
  rateLimitTier: string | null
  oneMDisabled: boolean
  /** The EXACT legacy built-in default expression (the fallback). */
  opusFallbackSetting: string
}

/** Evaluate the built-in Fable 5 frontier entry. */
function evaluateFableCandidate(f: FrontierFacts): FrontierCandidateVerdict {
  const base = { id: f.fableId, family: 'fable', rank: 100 }
  const verdict = (
    eligible: boolean,
    code: FrontierEligibilityCode,
  ): FrontierCandidateVerdict => ({ ...base, eligible, code })

  // A present-and-excluding availableModels is a REAL exclusion on every rung.
  if (f.allowlistPresent && !f.allowlistPermits(f.fableId)) {
    return verdict(false, 'allowlist-excluded')
  }
  // Pre-existing explicit operator signals stay eligibility evidence.
  if (f.fableEnvPin) {
    return verdict(true, 'eligible-env-pin')
  }
  if (f.allowlistNamesFable) {
    return verdict(true, 'eligible-allowlist')
  }
  // The launch rung: confirmed Max 20x — never guessed from a Max label.
  if (!f.claudeAiSubscriber) {
    return verdict(false, 'not-subscriber')
  }
  if (!f.maxSubscriber) {
    return verdict(false, 'not-max')
  }
  if (f.rateLimitTier === null) {
    return verdict(false, 'unknown-rate-limit-tier')
  }
  if (f.rateLimitTier !== FRONTIER_MAX_20X_TIER) {
    return verdict(false, 'not-20x')
  }
  return verdict(true, 'eligible-max-20x')
}

/**
 * The model-SETTING string for a winning candidate. The env-pin rung resolves
 * the pin VERBATIM (byte-parity with the legacy `best` path — a custom or
 * 3P-mapped id must not grow a suffix). Built-in Fable 5 carries `[1m]`:
 * its base window is 200K with API-granted 1M (no extra-usage tier), so the
 * suffix keeps 1M-default parity; the kill-switch drops it.
 */
function settingForWinner(
  f: FrontierFacts,
  winner: FrontierCandidateVerdict,
): string {
  if (winner.code === 'eligible-env-pin') {
    return winner.id
  }
  return f.oneMDisabled ? winner.id : winner.id + '[1m]'
}

/**
 * THE frontier-operator decision — the PURE core. Deterministic over `facts`;
 * no reads, no writes. The scripts/model-policy/ matrix drives every launch-matrix,
 * ordering and migration row through this function with injected facts.
 */
export function evaluateFrontierDecision(
  facts: FrontierFacts,
): FrontierOperatorDecision {
  const candidates: FrontierCandidateVerdict[] = [evaluateFableCandidate(facts)]

  const winner = candidates.find(c => c.eligible) ?? null
  if (winner) {
    return {
      setting: settingForWinner(facts, winner),
      source: 'frontier',
      winner,
      candidates,
      code: winner.code,
    }
  }
  // The operator-facing "why not": the leading candidate's failure code.
  const diagnostic = candidates[0]
  return {
    setting: facts.opusFallbackSetting,
    source: 'fallback',
    winner: null,
    candidates,
    code: diagnostic?.code ?? 'no-registered-candidate',
  }
}

// Reentrancy guard: isModelAllowed() resolves alias allowlist entries (e.g.
// 'best') through parseUserSpecifiedModel → getBestModel → this decision. On
// reentry we skip the allowlist check (treat as allowed) — the exact semantics
// getBestModel's legacy `resolvingBest` guard had — so evaluation terminates.
let resolvingFrontier = false

function allowedUnderAllowlist(id: string): boolean {
  if (resolvingFrontier) {
    return true
  }
  resolvingFrontier = true
  try {
    return isModelAllowed(id)
  } finally {
    resolvingFrontier = false
  }
}

/**
 * Gather the live facts from the EXISTING owners (env, cached OAuth account
 * facts, settings). Read-only; no network.
 */
export function gatherFrontierFacts(): FrontierFacts {
  const settings = getSettings_DEPRECATED() || {}
  const allowlist = settings.availableModels
  return {
    fableEnvPin: !!process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    fableId: getDefaultFableModel(),
    allowlistPresent: allowlist !== undefined,
    allowlistNamesFable:
      !!allowlist &&
      allowlist.length > 0 &&
      allowlist.some(m => m.trim().toLowerCase().includes('fable')),
    allowlistPermits: allowedUnderAllowlist,
    claudeAiSubscriber: isClaudeAISubscriber(),
    maxSubscriber: isMaxSubscriber(),
    rateLimitTier: getRateLimitTier(),
    oneMDisabled: is1mContextDisabled(),
    // The [1m]-merge suffix belongs to the suffix-1M Opus 4.x line; a
    // natively-1M default Opus (Opus 5) carries its window on the bare id.
    opusFallbackSetting:
      getDefaultOpusModel() +
      (isOpus1mMergeEnabled() && !isDefaultOpusNatively1M() ? '[1m]' : ''),
  }
}

/** The live frontier-operator decision (pure core over gathered facts). */
export function frontierOperatorDecision(): FrontierOperatorDecision {
  return evaluateFrontierDecision(gatherFrontierFacts())
}

/**
 * One terse operator-facing line for the first-party family's gating (the
 * doctor's detail, the picker's first-party copy). Examples:
 *   `first-party frontier · Max 20x`      (the frontier row, via subscription)
 *   `first-party frontier · env pin`      (via ANTHROPIC_DEFAULT_FABLE_MODEL)
 *   `first-party fallback · not Max 20x`  (no eligible candidate — the next row down)
 */
export function describeFrontierDecision(
  decision: FrontierOperatorDecision,
): string {
  const why: Record<FrontierOperatorDecision['code'], string> = {
    'eligible-env-pin': 'env pin',
    'eligible-allowlist': 'model allowlist',
    'eligible-max-20x': 'Max 20x',
    'not-subscriber': 'no subscription facts',
    'not-max': 'not a Max subscription',
    'unknown-rate-limit-tier': 'unknown rate-limit tier',
    'not-20x': 'not Max 20x',
    'allowlist-excluded': 'excluded by allowlist',
    'no-registered-candidate': 'no registered candidate',
  }
  return decision.source === 'frontier'
    ? `first-party frontier · ${why[decision.code]}`
    : `first-party fallback · ${why[decision.code]}`
}
