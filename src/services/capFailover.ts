// ============================================================================
//  services/capFailover — the R5 cap-survival decision core (
//  R04/R05; candidate set multi-auth since the CP-A widening).
//
//  The operational mission: no single-vendor outage — a capped Anthropic
//  window hands off to the readiest usable lane of the OTHER families
//  (OpenAI first — the ratified relief lane — then the readiness-checked
//  catalogue) and comes home on reset. This module is the PURE decision
//  layer over the observed quota truth:
//
//    posture 'offer' — the DEFAULT (FN-013 MODEL-05, the operator-accepted
//                      release-note change superseding R5's off default):
//                      allowed_warning (preemptive, clean-boundary) and
//                      rejected present a one-keypress OFFER; the card
//                      opens the transition preview and confirm settles through
//                      the EXISTING owner at the safe boundary. An offer
//                      NEVER switches anything, and it never appears when
//                      no target lane is usable (liveCapFailoverTarget
//                      null keeps the surfaces quiet exactly as before).
//    posture 'off'   — the fully-inert cross-family posture, selectable
//                      and byte-identical to the old default: never
//                      switches, never offers.
//    posture 'auto'  — a rejected window hands off unattended at the safe
//                      boundary (daemon/overnight); warnings still OFFER
//                      (visible, never silent).
//
//  Return is posture-symmetric on the observed reset truth: once the window
//  resets, the SAME posture logic offers/executes the way home (Anthropic
//  is the subscription lane — prompt return is the economic default).
//  Arming is the standing explicit operator act (the boot-menu row writes
//  the registered flag); this module never writes state — the offer/auto
//  surfaces consume the decision and settle through settleModelSelection.
// ============================================================================
import { flagEnv } from '../substrate/flagRegistry.js'

export type CapPosture = 'off' | 'offer' | 'auto'

export type CapQuota = 'allowed' | 'allowed_warning' | 'rejected'

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
 *  resolves 'offer' (FN-013 MODEL-05): the fully-built handoff offer is
 *  reachable without pre-arming, and an offer never switches anything.
 *  Unknown values degrade in the SAFE direction (ask, never unattended —
 *  a typo'd 'auto' asks instead of moving). Explicit 'off' stays the
 *  fully-inert posture; 'auto' stays the explicit unattended arming. */
export function resolveCapPosture(): CapPosture {
  const raw = flagEnv('MERCURY_CAP_FAILOVER')
  return raw === 'off' || raw === 'auto' ? raw : 'offer'
}

/** The pure decision: posture × quota → action. The default-off no-op law
 *  is total — 'off' yields 'none' for EVERY quota state. */
export function decideCapAction(posture: CapPosture, quota: CapQuota): CapAction {
  if (posture === 'off') return { kind: 'none' }
  if (quota === 'allowed') return { kind: 'none' }
  if (quota === 'allowed_warning') return { kind: 'offer', trigger: 'warning' }
  // rejected:
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'rejected' }
    : { kind: 'offer', trigger: 'rejected' }
}

// ── the failover-lane note (session-scoped, never persisted) ────────────────
// Set when a cap-triggered handoff is ACCEPTED (offer confirm / auto apply);
// cleared on the way home. The return surfaces guard on BOTH this note and
// the live route — an abandoned preview leaves the route on anthropic, so a
// stale note alone can never fire a return offer.
let capHandoff: { homeModel: string | null } | null = null

/** Record the accepted handoff — homeModel is the model to come home to. */
export function noteCapHandoff(homeModel: string | null): void {
  capHandoff = { homeModel }
}

/** The way home completed (or the operator returned by hand). */
export function noteCapReturn(): void {
  capHandoff = null
}

export function capHandoffState(): { homeModel: string | null } | null {
  return capHandoff
}

// ── the offer memories (session-scoped, never persisted) ────────────────────
//  One dismissal per wall/decision key and one automatic action per key,
//  SHARED across every composer mount. These lived as useRef Sets inside the
//  composer component and died with it — and the composer unmounts for
//  EVERY tool-permission prompt (the screen renders the permission dialog
//  in its place) — so a dismissed offer card returned over the composer
//  after every approved tool call for as long as the window stood, against
//  the card's own "re-offers only on a NEW wall, never nags" law, and an
//  automatic action's once-per-key latch died the same way (FN-016 R8).
//  Keys stay the callers' own, already namespaced ('slot|family|seat|reset'
//  for the within-family rung; 'direction|status|reset' for the
//  cross-family rung), so both rungs share one pair of sets without
//  collision. Session-scoped like the handoff note above: a fresh boot
//  fairly re-offers a still-standing wall.

const offerDismissals = new Set<string>()
const offerAutoActions = new Set<string>()

/** Has this wall/decision key been dismissed this session? */
export function offerDismissed(key: string): boolean {
  return offerDismissals.has(key)
}

/** Record a dismissal (Escape on the offer card) for this key. */
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
}

/** The posture-symmetric RETURN decision: with work parked on the failover
 *  lane and the home window reset, the same posture speaks — off never
 *  moved (nothing to return); offer offers the way home; auto returns
 *  unattended at the safe boundary. */
export function decideCapReturn(
  posture: CapPosture,
  homeQuota: CapQuota,
  onFailoverLane: boolean,
): CapAction {
  if (!onFailoverLane || posture === 'off') return { kind: 'none' }
  if (homeQuota !== 'allowed') return { kind: 'none' } // the window has not reset
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
//  cross-family move (the R5 ratified default governs leaving the family;
//  staying inside it is the new law). No second slot, or the other slot's
//  OWN observed wall ⇒ none — this rung never invents headroom.

export type SlotWallAction = { kind: 'none' } | { kind: 'offer' } | { kind: 'auto-switch' }

export function decideSlotWallAction(
  posture: CapPosture,
  facts: { activeWalled: boolean; otherSignedIn: boolean; otherWalled: boolean },
): SlotWallAction {
  if (!facts.activeWalled || !facts.otherSignedIn || facts.otherWalled) return { kind: 'none' }
  return posture === 'auto' ? { kind: 'auto-switch' } : { kind: 'offer' }
}

// ── the failover candidate law (the CP-A multi-auth widening) ───────────────
//  The handoff TARGET derives from the WHOLE readiness-checked catalogue —
//  the one composed usability resolver (providers/providerUsability) over
//  every family — never an OpenAI-shaped list. The fence stays exactly as
//  strong as PV verified it:
//    · readiness-checked — only a lane whose composed usability is USABLE
//      (credential present, no live-limit block) may enter the set;
//    · anthropic is the HOME lane — never a candidate;
//    · no invented targets — a lane enters only with a target model from its
//      own truth owner (openai: the qualified seat catalogue's first id;
//      elsewhere: the family's recorded frontier fact). A family recording
//      none is EXCLUDED with a typed why — never a guessed id;
//    · no silent hop — this law only names candidates; movement still runs
//      offer-confirm / the operator-armed auto posture, and settles through
//      the one selection owner.
//  Pure over injected reads (the prover feeds fixtures); the live
//  composition below reads the owning stores.

/** The non-Anthropic families, in candidate order: OpenAI first (the
 *  ratified R5 relief lane), then the catalogue's stable order. */
export const CAP_FAILOVER_FAMILY_ORDER = [
  'openai',
  'zai',
  'moonshot',
  'deepseek',
  'huggingface',
  'openrouter',
  'gemini',
  'openai-compat',
  'local',
] as const

export type CapFailoverRoute = (typeof CAP_FAILOVER_FAMILY_ORDER)[number]

export interface CapFailoverCandidate {
  route: CapFailoverRoute
  /** A real dispatchable model id from the family's own truth owner. */
  model: string
}

export interface CapFailoverExclusion {
  route: CapFailoverRoute
  /** The typed why-not: the lane's own blockers, or the absent target fact. */
  why: string
}

export interface CapFailoverCandidateSet {
  candidates: CapFailoverCandidate[]
  excluded: CapFailoverExclusion[]
}

/** The pure candidate derivation: usability map × per-family target facts →
 *  the ordered candidate set + typed exclusions. anthropic never enters. */
export function deriveCapFailoverCandidates(
  usability: Record<string, { usable: boolean; blockers: string[] }>,
  targetModelOf: (route: CapFailoverRoute) => string | undefined,
): CapFailoverCandidateSet {
  const candidates: CapFailoverCandidate[] = []
  const excluded: CapFailoverExclusion[] = []
  for (const route of CAP_FAILOVER_FAMILY_ORDER) {
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
  return { candidates, excluded }
}

/** The LIVE candidate set: the composed usability resolver over every
 *  family × each family's own target-model owner (openai: the qualified
 *  seat catalogue; elsewhere: the recorded frontier fact). Late requires —
 *  the decision core stays import-light for the pure fence above. */
export function liveCapFailoverCandidates(): CapFailoverCandidateSet {
  const { resolveProviderUsability } =
    require('./providers/providerUsability.js') as typeof import('./providers/providerUsability.js')
  const { getGptSeatAvailability } =
    require('./providers/openai/openaiCatalogue.js') as typeof import('./providers/openai/openaiCatalogue.js')
  const { providerFrontierFact } =
    require('../utils/model/providerFrontier.js') as typeof import('../utils/model/providerFrontier.js')
  return deriveCapFailoverCandidates(resolveProviderUsability(), route => {
    if (route === 'openai') {
      const seat = getGptSeatAvailability()
      return seat.state === 'ready' ? seat.ids[0] : undefined
    }
    return providerFrontierFact(route)?.modelId
  })
}

/** The one handoff target the offer/auto surfaces present: the first
 *  candidate of the widened set, null when no lane qualifies (the surfaces
 *  then stay quiet exactly as before). */
export function liveCapFailoverTarget(): CapFailoverCandidate | null {
  return liveCapFailoverCandidates().candidates[0] ?? null
}
