
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
  'harness-profile',
] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

export interface CapabilityFact {
  kind: CapabilityKind
  state: CapabilityState
  source: string
  observedAt: number
}

export interface CapabilitySetV1 {
  v: 1
  seatId: string
  adapterKind: string
  revision: string
  facts: Map<CapabilityKind, CapabilityFact>
  observedAt: number
  invalidatedAt?: number
  invalidatedReason?: string
}

const sets = new Map<string, CapabilitySetV1>()

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

export function capabilitiesOf(seatId: string): CapabilitySetV1 | null {
  return sets.get(seatId) ?? null
}

export function invalidateCapabilities(seatId: string, reason: string): void {
  const set = sets.get(seatId)
  if (!set) return
  sets.set(seatId, { ...set, invalidatedAt: Date.now(), invalidatedReason: reason })
}

export function forgetCapabilities(seatId: string): void {
  sets.delete(seatId)
}

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

export function _resetCapabilitiesForTesting(): void {
  sets.clear()
}
