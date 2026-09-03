// ============================================================================
//  services/capFailover — the cap-survival decision core.
//
//  The operational mission: no single-vendor outage. When the family the
//  session runs on WALLS (a usage window approaching or reached, a credit
//  refusal), the session hands off to a usable lane of ANOTHER signed-in
//  family and comes home when the home window is observed to reset. This
//  module is the PURE decision layer over the observed window truth:
//
//    posture 'offer' — the DEFAULT: warning (preemptive, clean-boundary)
//                      and rejected present a one-keypress OFFER; the card
//                      opens the transition preview and confirm settles
//                      through the EXISTING owner at the safe boundary. An
//                      offer NEVER switches anything, and it never appears
//                      when no target lane is usable.
//    posture 'off'   — the fully-inert cross-family posture, selectable:
//                      never switches, never offers.
//    posture 'auto'  — a rejected window hands off unattended at the safe
//                      boundary (daemon/overnight); warnings still OFFER
//                      (visible, never silent).
//
//  THE NEUTRAL LAW (the operator's ruling): failover favours NO family.
//    · HOME is the lane the session was on before the handoff — ANY family;
//      the handoff note records the home model AND the home family.
//    · Every family's observed window facts sit behind ONE resolver
//      (observedFamilyWindow): anthropic reads the header/endpoint latch,
//      openai its per-source wall and usage bands, the engine lanes their
//      own latches, every lane its billing refusal. "Unknown" is a STATE —
//      nothing observed, or a credential that just changed — and is never
//      read as "allowed".
//    · The cross-family OFFER fires for ANY home family that walls; the
//      candidate set is every OTHER family that is signed in and usable,
//      ordered by the sign-in ledger's recency (the most recent sign-in
//      first, untimed credentials after every timed one) — never a
//      hardwired family-first list. anthropic IS a candidate when it is not
//      home.
//    · The RETURN offer needs the home family's window OBSERVED reset (a
//      fresh allowed observation, or the provider's own stated reset moment
//      passing) AND the home credential present and usable. A sign-out of
//      the home family clears the note: there is no home to return to.
//    · The within-family slot rung (subscription ↔ key) stays as it is,
//      for every family that has two slots.
//
//  Arming is the standing explicit operator act (the boot-menu row writes
//  the registered flag); this module never writes state — the offer/auto
//  surfaces consume the decision and settle through settleModelSelection.
// ============================================================================
import { flagEnv } from '../substrate/flagRegistry.js'

export type CapPosture = 'off' | 'offer' | 'auto'

/** The anthropic wire's own status vocabulary (claudeAiLimits). */
export type CapQuota = 'allowed' | 'allowed_warning' | 'rejected'

/** The family-neutral window state every lane's observation resolves to.
 *  'unknown' = nothing observed (a fresh boot, a credential that just
 *  changed, a lane that serves no usage signal) — never read as headroom. */
export type CapWindowState = 'allowed' | 'warning' | 'rejected' | 'unknown'

export type CapAction =
  | { kind: 'none' }
  | {
      kind: 'offer'
      /** Why the offer fired — the card names the window state. 'reset'
       *  is the posture-symmetric way HOME (the window recovered). */
      trigger: 'warning' | 'rejected' | 'reset'
    }
  | { kind: 'auto-handoff'; trigger: 'rejected' | 'reset' }

/** The posture read (registered flag). Unset — and any unknown spelling —
 *  resolves 'offer': the fully-built handoff offer is reachable without
 *  pre-arming, and an offer never switches anything. Unknown values
 *  degrade in the SAFE direction (ask, never unattended — a typo'd 'auto'
 *  asks instead of moving). Explicit 'off' stays the fully-inert posture;
 *  'auto' stays the explicit unattended arming. */
export function resolveCapPosture(): CapPosture {
  const raw = flagEnv('MERCURY_CAP_FAILOVER')
  return raw === 'off' || raw === 'auto' ? raw : 'offer'
}

/** The anthropic wire spelling folds onto the neutral state; every other
 *  spelling is already neutral. */
function windowStateOf(state: CapWindowState | CapQuota): CapWindowState {
  return state === 'allowed_warning' ? 'warning' : state
}

/** The pure decision: posture × window state → action. The off no-op law
 *  is total — 'off' yields 'none' for EVERY state; 'unknown' never fires
 *  anything (no observation is not a wall). */
export function decideCapAction(posture: CapPosture, state: CapWindowState | CapQuota): CapAction {
  if (posture === 'off') return { kind: 'none' }
  const window = windowStateOf(state)
  if (window === 'allowed' || window === 'unknown') return { kind: 'none' }
  if (window === 'warning') return { kind: 'offer', trigger: 'warning' }
  // rejected:
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'rejected' }
    : { kind: 'offer', trigger: 'rejected' }
}

// ── the failover-lane note (session-scoped, never persisted) ────────────────
// Set when a cap-triggered handoff is ACCEPTED (offer confirm / auto apply);
// cleared on the way home, and when the home family's credential leaves.
// The return surfaces guard on BOTH this note and the live route — an
// abandoned preview leaves the route on the home family, so a stale note
// alone can never fire a return offer.

export interface CapHandoffNote {
  /** The model to come home to (null = the resolved default). */
  homeModel: string | null
  /** The family the session was on before the handoff — the lane whose
   *  window the return decision watches. */
  homeFamily: string
}

let capHandoff: CapHandoffNote | null = null

/** Record the accepted handoff — the model AND the family to come home to. */
export function noteCapHandoff(homeModel: string | null, homeFamily: string): void {
  capHandoff = { homeModel, homeFamily }
}

/** The way home completed (or the operator returned by hand). */
export function noteCapReturn(): void {
  capHandoff = null
}

export function capHandoffState(): CapHandoffNote | null {
  return capHandoff
}

/** The home family's credential LEFT (a slot removed, /logout): there is
 *  no home to return to, so the note clears — the removal owners call
 *  this. A note whose home is another family stands. */
export function clearCapHandoffForFamily(family: string): void {
  if (capHandoff !== null && capHandoff.homeFamily === family) capHandoff = null
}

// ── the offer memories (session-scoped, never persisted) ────────────────────
//  One dismissal per wall/decision key and one automatic action per key,
//  SHARED across every composer mount. These lived as useRef Sets inside the
//  composer component and died with it — and the composer unmounts for
//  EVERY tool-permission prompt (the screen renders the permission dialog
//  in its place) — so a dismissed offer card returned over the composer
//  after every approved tool call for as long as the window stood, against
//  the card's own "re-offers only on a NEW wall, never nags" law, and an
//  automatic action's once-per-key latch died the same way.
//  Keys stay the callers' own, already namespaced ('slot|family|seat|reset'
//  for the within-family rung; 'direction|family|state|reset' for the
//  cross-family rung), so both rungs share one pair of sets without
//  collision. Session-scoped like the handoff note above: a fresh boot
//  fairly re-offers a still-standing wall. An ACCEPTED offer latches its key
//  exactly like a dismissal — whatever the selection path then decides
//  (applied, previewed, refused), the same card never re-fires for the same
//  wall.

const offerDismissals = new Set<string>()
const offerAutoActions = new Set<string>()

/** Has this wall/decision key been dismissed (or accepted) this session? */
export function offerDismissed(key: string): boolean {
  return offerDismissals.has(key)
}

/** Record a dismissal (Escape on the offer card, or an accept — the card
 *  has been answered either way) for this key. */
export function noteOfferDismissal(key: string): void {
  offerDismissals.add(key)
}

/** Has the automatic action for this key already run this session? */
export function offerAutoDone(key: string): boolean {
  return offerAutoActions.has(key)
}

/** Latch the automatic action for this key (at most once per key). */
export function noteOfferAutoDone(key: string): void {
  offerAutoActions.add(key)
}

/** TEST-ONLY: provers reset the session-scoped memories between arms. */
export function _resetOfferMemoriesForTesting(): void {
  offerDismissals.clear()
  offerAutoActions.clear()
  answeredCapOffers.clear()
  capHandoff = null
}

// ── the CROSS-FAMILY offer's armed state (ONE stable owner) ─────────────────
//  The set above keys on the caller's own string. The cross-family rung's
//  string carried the window STATE and the stated RESET moment
//  ('direction|family|state|reset') — both VOLATILE: a window fills from
//  'warning' to 'rejected', and its stated reset shifts by seconds as each
//  fresh usage header is re-observed (the facts read a confirm triggers
//  re-adopts the OpenAI bands). Every drift minted a NEW key the answer had
//  never latched, so the answered offer re-fired on the very next commit —
//  offer → preview → confirm → offer, forever, the switch never settling
//  because the card kept returning over it.
//
//  This owner latches the answered/actioned state on the STABLE facts alone —
//  the direction and the family. An offer ANSWERED (accepted or Esc) or an
//  auto action taken disarms for that (direction, family) until the facts
//  MATERIALLY change, never on a state/reset jitter:
//    · the home family's window is OBSERVED RECOVERED ('allowed', a real
//      reset) — the HANDOFF re-arms (a genuinely new wall may re-offer);
//    · the window caps AGAIN ('warning'/'rejected') — the RETURN re-arms (a
//      later reset may re-offer the way home).
//  'unknown' (nothing observed) is not a transition and re-arms neither, so a
//  credential that just changed never re-nags. Session-scoped like the
//  memories above: a fresh boot fairly re-offers a still-standing wall.

export type CapOfferDirection = 'handoff' | 'return'
const answeredCapOffers = new Set<string>()
const capOfferArmKey = (direction: CapOfferDirection, family: string): string =>
  `${direction}|${family}`

/** Has the cross-family offer for this (direction, family) already been
 *  answered — accepted, dismissed, or its auto action taken — for the wall
 *  that still stands? While true the card never re-fires, whatever the
 *  selection path then decides (applied, previewed, refused). */
export function capOfferAnswered(direction: CapOfferDirection, family: string): boolean {
  return answeredCapOffers.has(capOfferArmKey(direction, family))
}

/** Latch the cross-family offer's answered state (an accept, an Esc, or an
 *  auto handoff/return). The next material change re-arms it. */
export function noteCapOfferAnswered(direction: CapOfferDirection, family: string): void {
  answeredCapOffers.add(capOfferArmKey(direction, family))
}

/** The family's window was OBSERVED this commit — re-arm the offer whose wall
 *  the observation ended. A real reset ('allowed') re-arms the HANDOFF; a
 *  window that caps again ('warning'/'rejected') re-arms the RETURN. 'unknown'
 *  is nothing observed and re-arms neither (state/reset jitter within one wall
 *  never reaches 'allowed', so the answered handoff stays disarmed — the loop
 *  cannot re-open). */
export function noteCapWindowObserved(family: string, state: CapWindowState): void {
  if (state === 'allowed') {
    answeredCapOffers.delete(capOfferArmKey('handoff', family))
  } else if (state === 'warning' || state === 'rejected') {
    answeredCapOffers.delete(capOfferArmKey('return', family))
  }
}

/** What the RETURN decision knows about the home family. */
export interface CapReturnHomeFacts {
  /** The home family's OBSERVED window state (observedFamilyWindow). */
  window: CapWindowState | CapQuota
  /** The home credential is present and usable right now (the usability
   *  resolver's verdict) — a signed-out home is no home. */
  credentialUsable: boolean
}

/** The posture-symmetric RETURN decision: with work parked on the failover
 *  lane, the home window OBSERVED reset and the home credential usable,
 *  the same posture speaks — off never moved (nothing to return); offer
 *  offers the way home; auto returns unattended at the safe boundary.
 *  'unknown' is not a reset: "nothing observed" never opens the way home. */
export function decideCapReturn(
  posture: CapPosture,
  home: CapReturnHomeFacts,
  onFailoverLane: boolean,
): CapAction {
  if (!onFailoverLane || posture === 'off') return { kind: 'none' }
  if (!home.credentialUsable) return { kind: 'none' } // no home to return to
  if (windowStateOf(home.window) !== 'allowed') return { kind: 'none' } // the window has not (observably) reset
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'reset' }
    : { kind: 'offer', trigger: 'reset' }
}

// ── the WITHIN-FAMILY slot rung ─────────────────────────────────────────────
//  BEFORE any cross-family move: a walled ACTIVE slot whose family holds a
//  second signed-in slot with headroom offers the SLOT switch. The
//  operator's law re-dials the posture for THIS rung only —
//  "OFF (default) = the ask; ON = auto-failover at the wall" — so the wall
//  is never a dead end: postures off and offer both ASK (one key), and
//  auto switches unattended (silent, receipted on the wall row + the slot
//  state). decideCapAction's total off-no-op stays untouched for the
//  cross-family move. No second slot, or the other slot's OWN observed
//  wall ⇒ none — this rung never invents headroom.

export type SlotWallAction = { kind: 'none' } | { kind: 'offer' } | { kind: 'auto-switch' }

export function decideSlotWallAction(
  posture: CapPosture,
  facts: { activeWalled: boolean; otherSignedIn: boolean; otherWalled: boolean },
): SlotWallAction {
  if (!facts.activeWalled || !facts.otherSignedIn || facts.otherWalled) return { kind: 'none' }
  return posture === 'auto' ? { kind: 'auto-switch' } : { kind: 'offer' }
}

// ── the per-family OBSERVED window resolver ─────────────────────────────────
//  ONE answer to "what has this family's wire said about its window", for
//  every family, in one vocabulary. Nothing here probes: every arm reads a
//  latch some response already filled. The two honest transitions out of a
//  wall are a FRESH allowed observation and the provider's OWN stated reset
//  moment passing (the wire said "resets at T"; T passed) — a bare latch
//  that reads 'clear' cannot tell "never walled" from "walled, then reset",
//  so the resolver reads the raw wall records, elapsed or not.

export type CapWindowBasis =
  /** A response (or the usage endpoint) stated this state. */
  | 'observed'
  /** A wall was stated with a reset moment, and that moment has passed. */
  | 'stated-reset-elapsed'
  /** Nothing observed on this family (or its credential just changed). */
  | 'none'

export interface FamilyWindowFact {
  family: string
  state: CapWindowState
  basis: CapWindowBasis
  /** The stated reset moment (epoch ms), when the wire stated one. */
  resetsAtMs?: number
  /** The window's display name ('weekly limit', 'weekly window',
   *  'credits'), when the wire named one. */
  windowName?: string
}

/** Injectable reads for provers; the live bundle reads each family's OWN
 *  latch module. */
export interface FamilyWindowReads {
  now?: () => number
  anthropic?: () => {
    status: CapQuota
    /** true once a response or the usage endpoint has been observed since
     *  the last credential change (claudeAiLimits.claudeWindowObserved). */
    observed: boolean
    resetsAtMs?: number
    windowName?: string
  }
  openaiActiveSource?: () => 'chatgpt-subscription' | 'api-key' | undefined
  openaiWall?: (source: 'chatgpt-subscription' | 'api-key') => { resetsAtMs: number } | null
  /** The subscription's observed usage bands (openaiLimitState), each
   *  with its display word. */
  openaiBands?: () => Array<{ usedPct: number; resetsAtMs?: number; windowName: string }>
  openrouterWall?: () => { resetsAtMs: number } | null
  geminiWall?: () => { resetsAtMs: number } | null
  huggingfaceWall?: () => { resetsAtMs: number } | null
  /** A lane's observed billing refusal (the runtime-fed owner; the Hugging
   *  Face 402 latch folds in on the live bundle). */
  laneBilling?: (family: string) => { state: 'credit-exhausted' | 'clear' }
}

/** The approaching threshold the strip warning already uses (limitWarning's
 *  APPROACHING_LIMIT_PCT) — one number, spelled here so the pure resolver
 *  stays import-light; the prover pins the two equal. */
export const CAP_APPROACHING_PCT = 70

function liveFamilyWindowReads(): Required<FamilyWindowReads> {
  return {
    now: Date.now,
    anthropic: () => {
      const limits = require('./claudeAiLimits.js') as typeof import('./claudeAiLimits.js')
      const current = limits.currentLimits
      return {
        status: current.status,
        observed: limits.claudeWindowObserved(),
        ...(current.resetsAt !== undefined ? { resetsAtMs: current.resetsAt * 1000 } : {}),
        ...(current.rateLimitType !== undefined
          ? { windowName: limits.getRateLimitDisplayName(current.rateLimitType) }
          : {}),
      }
    },
    openaiActiveSource: () => {
      const { resolveOpenaiAccount } =
        require('./providers/openai/openaiAccounts.js') as typeof import('./providers/openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.kind
    },
    openaiWall: source => {
      const { openaiObservedWall } =
        require('./providers/openai/openaiLimitState.js') as typeof import('./providers/openai/openaiLimitState.js')
      return openaiObservedWall(source)
    },
    openaiBands: () => {
      const { openaiObservedUsage } =
        require('./providers/openai/openaiLimitState.js') as typeof import('./providers/openai/openaiLimitState.js')
      const { usageWindowLabel } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      const observed = openaiObservedUsage()
      const bands: Array<{ usedPct: number; resetsAtMs?: number; windowName: string }> = []
      for (const band of [observed.primary, observed.secondary]) {
        if (band === undefined || band.usedPct === undefined) continue
        const label = usageWindowLabel(band.windowMinutes)
        bands.push({
          usedPct: band.usedPct,
          ...(band.resetsAtMs !== undefined ? { resetsAtMs: band.resetsAtMs } : {}),
          windowName: label === 'wk' ? 'weekly window' : label === 'win' ? 'usage window' : `${label} window`,
        })
      }
      return bands
    },
    openrouterWall: () => {
      const { openrouterObservedWall } =
        require('./providers/openrouter/openrouterUsageState.js') as typeof import('./providers/openrouter/openrouterUsageState.js')
      return openrouterObservedWall()
    },
    geminiWall: () => {
      const { geminiObservedWall } =
        require('./providers/gemini/geminiUsageState.js') as typeof import('./providers/gemini/geminiUsageState.js')
      return geminiObservedWall()
    },
    huggingfaceWall: () => {
      const { huggingfaceObservedWall } =
        require('./providers/huggingface/huggingfaceUsageState.js') as typeof import('./providers/huggingface/huggingfaceUsageState.js')
      return huggingfaceObservedWall()
    },
    laneBilling: family => {
      if (family === 'huggingface') {
        const { huggingfaceBillingState } =
          require('./providers/huggingface/huggingfaceUsageState.js') as typeof import('./providers/huggingface/huggingfaceUsageState.js')
        if (huggingfaceBillingState().state === 'credit-exhausted') return { state: 'credit-exhausted' }
      }
      const { laneBillingState } =
        require('./providers/laneBillingState.js') as typeof import('./providers/laneBillingState.js')
      return { state: laneBillingState(family as Parameters<typeof laneBillingState>[0]).state }
    },
  }
}

/** A stated wall against the clock: ahead ⇒ rejected (observed); passed ⇒
 *  allowed by the provider's own stated reset. */
function wallFact(family: string, wall: { resetsAtMs: number }, now: number, windowName: string): FamilyWindowFact {
  return wall.resetsAtMs > now
    ? { family, state: 'rejected', basis: 'observed', resetsAtMs: wall.resetsAtMs, windowName }
    : { family, state: 'allowed', basis: 'stated-reset-elapsed', resetsAtMs: wall.resetsAtMs }
}

/**
 * THE family window resolver. Pure over injected reads (the prover feeds
 * fixtures); the live default reads each family's own latch. Never throws:
 * a reader that cannot answer reads as 'unknown' (basis 'none').
 */
export function observedFamilyWindow(family: string, reads?: FamilyWindowReads): FamilyWindowFact {
  const r: Required<FamilyWindowReads> = { ...liveFamilyWindowReads(), ...stripUndefined(reads) }
  const unknown: FamilyWindowFact = { family, state: 'unknown', basis: 'none' }
  try {
    const now = r.now()
    if (family === 'anthropic') {
      const a = r.anthropic()
      if (!a.observed) return unknown
      const windowName = a.windowName ?? 'usage window'
      if (a.status === 'rejected' || a.status === 'allowed_warning') {
        if (a.resetsAtMs !== undefined && a.resetsAtMs <= now) {
          return { family, state: 'allowed', basis: 'stated-reset-elapsed', resetsAtMs: a.resetsAtMs }
        }
        return {
          family,
          state: a.status === 'rejected' ? 'rejected' : 'warning',
          basis: 'observed',
          ...(a.resetsAtMs !== undefined ? { resetsAtMs: a.resetsAtMs } : {}),
          windowName,
        }
      }
      return { family, state: 'allowed', basis: 'observed' }
    }
    if (family === 'openai') {
      const source = r.openaiActiveSource()
      if (source === undefined) return unknown
      const wall = r.openaiWall(source)
      if (wall !== null) return wallFact(family, wall, now, 'usage window')
      if (source === 'chatgpt-subscription') {
        // The observed bands: a band whose stated reset has passed is
        // stale, not headroom; the worst live band decides.
        const live = r.openaiBands().filter(band => band.resetsAtMs === undefined || band.resetsAtMs > now)
        if (live.length === 0) return billingOrUnknown(family, r, unknown)
        const worst = live.reduce((a, b) => (b.usedPct > a.usedPct ? b : a))
        if (worst.usedPct >= CAP_APPROACHING_PCT) {
          return {
            family,
            state: 'warning',
            basis: 'observed',
            ...(worst.resetsAtMs !== undefined ? { resetsAtMs: worst.resetsAtMs } : {}),
            windowName: worst.windowName,
          }
        }
        return { family, state: 'allowed', basis: 'observed' }
      }
      return billingOrUnknown(family, r, unknown)
    }
    const laneWall =
      family === 'openrouter'
        ? r.openrouterWall()
        : family === 'gemini'
          ? r.geminiWall()
          : family === 'huggingface'
            ? r.huggingfaceWall()
            : null
    if (laneWall !== null) return wallFact(family, laneWall, now, 'usage window')
    return billingOrUnknown(family, r, unknown)
  } catch {
    return unknown
  }
}

/** A lane whose wire refused the last turn for credit is walled (the
 *  refusal is observed; a settled turn clears it at its owner); otherwise
 *  the family has stated nothing this resolver can read. */
function billingOrUnknown(
  family: string,
  r: Required<FamilyWindowReads>,
  unknown: FamilyWindowFact,
): FamilyWindowFact {
  const billing = r.laneBilling(family)
  return billing.state === 'credit-exhausted'
    ? { family, state: 'rejected', basis: 'observed', windowName: 'credits' }
    : unknown
}

function stripUndefined<T extends object>(reads: T | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (reads === undefined) return out
  for (const [key, value] of Object.entries(reads)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

// ── the failover candidate law (family-neutral) ─────────────────────────────
//  The handoff TARGET derives from the WHOLE readiness-checked catalogue —
//  the one composed usability resolver (providers/providerUsability) over
//  every family — never a family-shaped list. The fence:
//    · readiness-checked — only a lane whose composed usability is USABLE
//      (credential present, no live-limit block) may enter the set;
//    · the HOME family is never a candidate for its own handoff — every
//      other family is, anthropic included when it is not home;
//    · sign-in recency orders the set (the neutral-default ruling: the most
//      recent sign-in first; an untimed credential — an env pin, a keyless
//      endpoint — after every timed one, in the resolver's own order);
//    · no invented targets — a lane enters only with a target model from its
//      own truth owner (openai: the qualified seat catalogue's first id;
//      elsewhere: the family's recorded frontier fact). A family recording
//      none is EXCLUDED with a typed why — never a guessed id;
//    · no silent hop — this law only names candidates; movement still runs
//      offer-confirm / the operator-armed auto posture, and settles through
//      the one selection owner.
//  Pure over injected reads (the prover feeds fixtures); the live
//  composition below reads the owning stores.

export interface CapFailoverCandidate {
  route: string
  /** A real dispatchable model id from the family's own truth owner. */
  model: string
}

export interface CapFailoverExclusion {
  route: string
  /** The typed why-not: the lane's own blockers, or the absent target fact. */
  why: string
}

export interface CapFailoverCandidateSet {
  /** The family the set was derived for (never a member). */
  home: string | null
  candidates: CapFailoverCandidate[]
  excluded: CapFailoverExclusion[]
}

/** The families of a usability map in candidate order: sign-in recency
 *  (most recent first), untimed after timed, ties in the map's own order. */
export function orderFamiliesBySignIn(
  families: readonly string[],
  signInAt: (family: string) => number | undefined,
): string[] {
  return families
    .map((family, index) => ({ family, index, at: signInAt(family) }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at
      if (a.at !== undefined && b.at === undefined) return -1
      if (a.at === undefined && b.at !== undefined) return 1
      return a.index - b.index
    })
    .map(entry => entry.family)
}

/** The pure candidate derivation: home × usability map × per-family target
 *  facts × sign-in recency → the ordered candidate set + typed exclusions.
 *  The home family never enters; every other family is judged alike. */
export function deriveCapFailoverCandidates(
  home: string | null,
  usability: Record<string, { usable: boolean; blockers: string[] }>,
  targetModelOf: (route: string) => string | undefined,
  signInAt: (family: string) => number | undefined = () => undefined,
): CapFailoverCandidateSet {
  const candidates: CapFailoverCandidate[] = []
  const excluded: CapFailoverExclusion[] = []
  const families = orderFamiliesBySignIn(
    Object.keys(usability).filter(family => family !== home),
    signInAt,
  )
  for (const route of families) {
    const lane = usability[route]
    if (lane === undefined || !lane.usable) {
      excluded.push({
        route,
        why: lane !== undefined && lane.blockers.length > 0 ? lane.blockers.join(' · ') : 'lane not usable',
      })
      continue
    }
    const model = targetModelOf(route)
    if (model === undefined || model.trim() === '') {
      excluded.push({ route, why: 'no recorded target model fact — never a guessed id' })
      continue
    }
    candidates.push({ route, model })
  }
  return { home, candidates, excluded }
}

/** The LIVE candidate set for a home family: the composed usability
 *  resolver over every family × each family's own target-model owner
 *  (openai: the qualified seat catalogue; elsewhere: the recorded frontier
 *  fact) × the sign-in ledger's recency. Late requires — the decision core
 *  stays import-light for the pure fence above. */
/** The EXACT id of the newest first-party frontier MEMBER — the id the seat
 *  and the catalogue persist (e.g. claude-fable-5-1), never the generation's
 *  base member. The first-party frontier fact answers the family DEFAULT
 *  (getDefaultFableModel → claude-fable-5; the canonicaliser collapses every
 *  'fable-5' spelling onto it), so an offer built from it would hand the
 *  session the OLDER model when a newer frontier member exists — the switch
 *  target must be the frontier the operator actually runs. The model-config
 *  table is the exact-id owner: among the registered fable members the
 *  highest generation wins (claude-fable-5-1 over claude-fable-5), read live
 *  so a later member needs no touch here. Falls back to the passed id when the
 *  table cannot be read or names no fable member. */
function newestFirstPartyFrontierMember(fallback: string): string {
  try {
    const { CANONICAL_MODEL_IDS } =
      require('../utils/model/configs.js') as typeof import('../utils/model/configs.js')
    const rank = (id: string): number => {
      const m = /^claude-fable-(\d+)(?:-(\d+))?$/.exec(id)
      return m === null ? -1 : Number(m[1]) * 1000 + (m[2] !== undefined ? Number(m[2]) : 0)
    }
    let best: { id: string; rank: number } | undefined
    for (const id of CANONICAL_MODEL_IDS) {
      const r = rank(id)
      if (r >= 0 && (best === undefined || r > best.rank)) best = { id, rank: r }
    }
    return best?.id ?? fallback
  } catch {
    return fallback
  }
}

/** TEST-ONLY: the exact-id resolver, so a prover pins the newest-member
 *  upgrade without seeding a whole live credential estate. */
export function _firstPartyFrontierMemberForTest(fallback: string): string {
  return newestFirstPartyFrontierMember(fallback)
}

export function liveCapFailoverCandidates(home: string | null): CapFailoverCandidateSet {
  const { resolveProviderUsability } =
    require('./providers/providerUsability.js') as typeof import('./providers/providerUsability.js')
  const { getGptSeatAvailability } =
    require('./providers/openai/openaiCatalogue.js') as typeof import('./providers/openai/openaiCatalogue.js')
  const { providerFrontierFact } =
    require('../utils/model/providerFrontier.js') as typeof import('../utils/model/providerFrontier.js')
  const { readSignInLedger } =
    require('../utils/accounts/signInLedger.js') as typeof import('../utils/accounts/signInLedger.js')
  const ledger = ((): Record<string, { at: number }> => {
    try {
      return readSignInLedger()
    } catch {
      return {}
    }
  })()
  return deriveCapFailoverCandidates(
    home,
    resolveProviderUsability(),
    route => {
      if (route === 'openai') {
        const seat = getGptSeatAvailability()
        return seat.state === 'ready' ? seat.ids[0] : undefined
      }
      const fact = providerFrontierFact(route as Parameters<typeof providerFrontierFact>[0])?.modelId
      // The first-party frontier fact answers the family default; the offer
      // switches to the NEWEST frontier member the picker/seat persist.
      return route === 'anthropic' && fact !== undefined
        ? newestFirstPartyFrontierMember(fact)
        : fact
    },
    family => ledger[family]?.at,
  )
}

/** The one handoff target the offer/auto surfaces present for a home
 *  family: the first candidate of the ordered set, null when no lane
 *  qualifies (the surfaces then stay quiet). */
export function liveCapFailoverTarget(home: string | null): CapFailoverCandidate | null {
  return liveCapFailoverCandidates(home).candidates[0] ?? null
}

// ── the spend posture words (one composer, every family) ────────────────────

export type LaneSpendKind = 'subscription' | 'metered' | 'local' | 'endpoint' | 'none'

/** How a lane bills, from its credential kind — the card's spend line and
 *  the return line speak these words for HOME and AWAY alike. */
export function laneSpendPosture(
  route: string,
  credential: 'oauth' | 'api-key' | 'keyless' | 'none',
  displayName: string,
): { kind: LaneSpendKind; words: string } {
  if (route === 'local') {
    return { kind: 'local', words: `the ${displayName} lane runs on your own server — no API billing` }
  }
  if (route === 'openai-compat') {
    return { kind: 'endpoint', words: `the ${displayName} lane bills per its endpoint's own terms` }
  }
  if (credential === 'none') {
    return { kind: 'none', words: `the ${displayName} lane has no credential` }
  }
  if (credential === 'oauth' && (route === 'anthropic' || route === 'openai' || route === 'moonshot')) {
    return { kind: 'subscription', words: `the ${displayName} lane runs on your ${displayName} subscription` }
  }
  return {
    kind: 'metered',
    words: `the ${displayName} lane bills per token under your ${displayName} account`,
  }
}
