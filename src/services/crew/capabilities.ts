// ============================================================================
//  crew/capabilities — tri-state OBSERVED capability facts.
//
//  One vocabulary for what a seat (native or external) can actually do. The
//  laws:
//    · every fact is supported | unsupported | unknown, WITH the source and
//      the adapter revision/handshake that established it — never a bare
//      boolean, never a guess;
//    · absence means unknown (or unsupported where the protocol defines
//      absence) — it NEVER means "probably works";
//    · observations EXPIRE: a reconnect, renegotiation or revision change
//      invalidates the whole set — a stale fact cannot authorize a new
//      operation (authorizeCapability re-checks liveness);
//    · facts are PROCESS-scoped observations of live endpoints, deliberately
//      not durable: a restart forgets everything, and forgotten = unknown,
//      which is the safe direction by construction.
//
//  Mercury-local queue capabilities (hold-next on the command queue) are a
//  SEPARATE fact from remote current-turn steering and are never advertised
//  as proof of remote support — the dispatch transaction (dispatch.ts) reads
//  per-endpoint facts only.
// ============================================================================

export const CAPABILITY_STATES = ['supported', 'unsupported', 'unknown'] as const
export type CapabilityState = (typeof CAPABILITY_STATES)[number]

export const CAPABILITY_KINDS = [
  'steer-current',
  'hold-next',
  'start-turn',
  'cancel-turn',
  'attach-file',
  'attach-image',
  'attach-selection',
  'resume-session',
  'set-title',
  'structured-activity',
  'usage-totals',
  'artifact-replies',
  // Can this seat apply a Mercury harness profile? External
  // seats structurally cannot — recorded 'unsupported' at attach, never left
  // 'unknown' (an exact limitation, not false state).
  'harness-profile',
] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

export interface CapabilityFact {
  kind: CapabilityKind
  state: CapabilityState
  /** What established the fact ('handshake', 'declared:<field>', 'profile'). */
  source: string
  observedAt: number
}

export interface CapabilitySetV1 {
  v: 1
  /** The live endpoint the observations belong to (seat id). */
  seatId: string
  adapterKind: string
  /** The adapter/CLI revision the handshake reported — a change invalidates. */
  revision: string
  facts: Map<CapabilityKind, CapabilityFact>
  observedAt: number
  /** Set when invalidated — a dead set answers 'unknown' for everything. */
  invalidatedAt?: number
  invalidatedReason?: string
}

const sets = new Map<string, CapabilitySetV1>()

/**
 * Record a fresh observation set (at handshake/renegotiation). Replaces any
 * prior set for the seat wholesale — capability sets are atomic observations,
 * never merged across handshakes.
 */
export function recordCapabilities(args: {
  seatId: string
  adapterKind: string
  revision: string
  declared: Partial<Record<CapabilityKind, { state: CapabilityState; source: string }>>
}): CapabilitySetV1 {
  const now = Date.now()
  const facts = new Map<CapabilityKind, CapabilityFact>()
  for (const kind of CAPABILITY_KINDS) {
    const d = args.declared[kind]
    facts.set(kind, {
      kind,
      state: d?.state ?? 'unknown',
      source: d?.source ?? 'absent-from-handshake',
      observedAt: now,
    })
  }
  // recordCapabilities runs only on EXTERNAL seat attaches
  // (the seatBridge handshake) — an external seat can never apply a Mercury
  // harness profile, a structural fact pinned here so no surface can show
  // 'unknown' (or worse, a false active profile) for it.
  facts.set('harness-profile', {
    kind: 'harness-profile',
    state: 'unsupported',
    source: 'external-seat-no-harness-application',
    observedAt: now,
  })
  const set: CapabilitySetV1 = {
    v: 1,
    seatId: args.seatId,
    adapterKind: args.adapterKind,
    revision: args.revision,
    facts,
    observedAt: now,
  }
  sets.set(args.seatId, set)
  return set
}

/** The current observation set (invalidated sets still returned — callers
 *  read `invalidatedAt`; authorizeCapability already refuses them). */
export function capabilitiesOf(seatId: string): CapabilitySetV1 | null {
  return sets.get(seatId) ?? null
}

/**
 * Expire a seat's observations (reconnect, revision change, detach, or a
 * renegotiation about to start). Stale facts cannot authorize anything after
 * this — every kind reads 'unknown' until a fresh handshake records again.
 */
export function invalidateCapabilities(seatId: string, reason: string): void {
  const set = sets.get(seatId)
  if (!set) return
  sets.set(seatId, { ...set, invalidatedAt: Date.now(), invalidatedReason: reason })
}

/** Drop a seat's set entirely (detach teardown). */
export function forgetCapabilities(seatId: string): void {
  sets.delete(seatId)
}

/** The fact for one kind — 'unknown' when unobserved or invalidated. */
export function capabilityStateOf(seatId: string, kind: CapabilityKind): CapabilityFact {
  const set = sets.get(seatId)
  if (!set || set.invalidatedAt !== undefined) {
    return {
      kind,
      state: 'unknown',
      source: set?.invalidatedAt !== undefined ? `invalidated:${set.invalidatedReason}` : 'never-observed',
      observedAt: Date.now(),
    }
  }
  return set.facts.get(kind)!
}

export type CapabilityAuthorization =
  | { ok: true; fact: CapabilityFact; revision: string }
  | { ok: false; reason: string; fact: CapabilityFact }

/**
 * THE authorization read for an operation about to run: only a LIVE,
 * positively-supported fact authorizes. Unknown and unsupported both refuse
 * (with the honest distinction in the reason); an invalidated set refuses
 * with its invalidation reason — never a stale yes.
 */
export function authorizeCapability(seatId: string, kind: CapabilityKind): CapabilityAuthorization {
  const set = sets.get(seatId)
  const fact = capabilityStateOf(seatId, kind)
  if (!set) return { ok: false, reason: `no capability observations for seat '${seatId}'`, fact }
  if (set.invalidatedAt !== undefined) {
    return { ok: false, reason: `observations expired (${set.invalidatedReason}) — renegotiate first`, fact }
  }
  if (fact.state === 'supported') return { ok: true, fact, revision: set.revision }
  return {
    ok: false,
    reason:
      fact.state === 'unsupported'
        ? `'${kind}' is unsupported by ${set.adapterKind} (${fact.source})`
        : `'${kind}' is unknown for ${set.adapterKind} — absence never means probably-works`,
    fact,
  }
}

/** Test seam (never product-read). */
export function _resetCapabilitiesForTesting(): void {
  sets.clear()
}
