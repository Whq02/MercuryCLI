// ============================================================================
//  services/capacity/governor — the ONE canonical
//  capacity owner. Every model-bearing surface in THIS process —
//  the foreground turn loop, background session seats, the Coordinator's
//  global lane, service queries — acquires a permit HERE before the provider
//  boundary; the UI projects receipts and never enforces a second counter.
//
// The provider-boundary backstop (the streamModel seam):
//  UI/supervisor-only checks are bypassable by reconnect, retry, or private
//  limiters — so the turn machine acquires per ATTEMPT, immediately before
//  its `model_call_started` emit, and releases in a finally that covers the
//  whole attempt including the fallback-continue and the throw. Re-acquiring
//  for the SAME callId revalidates idempotently (a held permit re-answers;
//  no double count).
//
//  Capacity is ADMISSION, not retention: lowering a ceiling
//  never revokes a held permit — it drains at release (hysteresis by
//  construction); raising admits waiters deterministically (FIFO within
//  class). THE INTERACTIVE RESERVE: the foreground lane is never queued
//  behind background work — background admission stops one lane short of
//  the ceiling unless the ceiling is 1 (then the single lane is shared
//  honestly, foreground-first in the queue).
//
//  Cross-process truth: the five-RUNTIME lease is daemon-side
//  (concourseSupervisor); each worker process runs ITS OWN governor guarding
//  its own provider calls (the per-session two-seat ledger lives where the
//  session lives). This module is deliberately process-local.
// ============================================================================
import { logForDebugging } from '../../utils/debug.js'

export type PermitLane = 'foreground' | 'background-session' | 'coordinator' | 'service'

export interface PermitRequest {
  lane: PermitLane
  /** The turn machine's per-attempt call identity — the idempotency key. */
  callId: string
  sessionId?: string
}

export interface PermitGrant {
  permitId: string
  callId: string
  lane: PermitLane
  /** 0 when granted immediately — the truthful queued/admission signal. */
  waitedMs: number
  /** True when this acquire re-answered an ALREADY-HELD permit (the
   *  same-callId idempotent revalidation — fallback retries). */
  reacquired: boolean
}

interface Waiter {
  req: PermitRequest
  enqueuedAt: number
  resolve: (grant: PermitGrant) => void
}

export interface GovernorCeilings {
  /** Concurrent model-bearing lanes in THIS process (≥1). */
  modelLanes: number
  /** Concurrent DELEGATED model-bearing lanes ('background-session' class —
   * subagents, workflow agents; ≥1). The composition maps the harness
   *  profile's maxConcurrentLanes BAND here (its true semantic is supported
   *  delegation width — a band-1 solo profile genuinely serializes
   *  delegation; band 3 defers to the machine allowance, never a duplicate
   *  in-process ceiling). Always ≤ the background allowance in effect. */
  delegationLanes: number
}

/** PERMISSIVE until the composition wires real ceilings (the refresh
 *  at the acquire seam): 16 matches the workflow limiter's own hard cap, so
 *  the backstop is LIVE at the provider boundary without newly constraining
 *  existing subagent fan-outs. */
const DEFAULT_CEILINGS: GovernorCeilings = { modelLanes: 16, delegationLanes: 16 }

let ceilings: GovernorCeilings = { ...DEFAULT_CEILINGS }
const held = new Map<string, PermitGrant>() // permitId → grant
const heldByCall = new Map<string, string>() // callId → permitId
const waiters: Waiter[] = []
let permitSeq = 0

/** Apply composed ceilings (the composition lives in
 *  composeCeilings.ts — role two-seat law, machine headroom, the profile
 *  delegation band; provider/account allowances join when their seams land
 *  at). Partial: an axis not named keeps its current value. */
export function setGovernorCeilings(next: Partial<GovernorCeilings>): void {
  const lanes = Math.max(1, Math.floor(next.modelLanes ?? ceilings.modelLanes))
  const delegation = Math.max(1, Math.floor(next.delegationLanes ?? ceilings.delegationLanes))
  ceilings = { modelLanes: lanes, delegationLanes: delegation }
  drainWaiters()
}

export function governorCeilings(): GovernorCeilings {
  return { ...ceilings }
}

/** The seat truth for THIS process: permits currently held. */
export function heldPermits(): readonly PermitGrant[] {
  return [...held.values()]
}

function backgroundAllowance(): number {
  // The interactive reserve: background stops one lane short (unless the
  // ceiling is 1 — then the single lane is honestly shared, queue-ordered
  // foreground-first).
  return ceilings.modelLanes <= 1 ? 1 : ceilings.modelLanes - 1
}

function heldDelegated(): number {
  let n = 0
  for (const g of held.values()) if (g.lane === 'background-session') n++
  return n
}

function mayAdmit(lane: PermitLane): boolean {
  const heldCount = held.size
  if (lane === 'foreground') return heldCount < ceilings.modelLanes
  if (heldCount >= backgroundAllowance()) return false
  // The delegated class additionally honors the composed delegation width
  // (the profile band): a solo-band session serializes its subagents while
  // service traffic keeps its own admission.
  if (lane === 'background-session') return heldDelegated() < ceilings.delegationLanes
  return true
}

function admit(req: PermitRequest, waitedMs: number): PermitGrant {
  const permitId = `perm-${++permitSeq}`
  const grant: PermitGrant = {
    permitId,
    callId: req.callId,
    lane: req.lane,
    waitedMs,
    reacquired: false,
  }
  held.set(permitId, grant)
  heldByCall.set(req.callId, permitId)
  return grant
}

function drainWaiters(): void {
  // Foreground-first within FIFO order (the reserve's queue half), then the
  // rest in arrival order — deterministic, starvation-free per class.
  for (;;) {
    const idx = (() => {
      const fg = waiters.findIndex(w => w.req.lane === 'foreground')
      if (fg !== -1 && mayAdmit('foreground')) return fg
      const any = waiters.findIndex(w => mayAdmit(w.req.lane))
      return any
    })()
    if (idx === -1) return
    const w = waiters.splice(idx, 1)[0]!
    w.resolve(admit(w.req, Date.now() - w.enqueuedAt))
  }
}

/**
 * Acquire a model permit — the provider-boundary gate. Resolves immediately
 * when a lane is free (waitedMs 0); otherwise queues (the truthful
 * admission wait the stream event narrates). Same-callId re-acquire while
 * held answers the SAME permit with reacquired=true (fallback retries
 * revalidate without double counting).
 */
export function acquireModelPermit(req: PermitRequest): Promise<PermitGrant> {
  const existing = heldByCall.get(req.callId)
  if (existing !== undefined) {
    const grant = held.get(existing)
    if (grant) return Promise.resolve({ ...grant, reacquired: true })
  }
  if (mayAdmit(req.lane)) {
    return Promise.resolve(admit(req, 0))
  }
  return new Promise<PermitGrant>(resolve => {
    waiters.push({ req, enqueuedAt: Date.now(), resolve })
  })
}

/** Release a permit — idempotent (a second release of the same id is a
 *  no-op); frees the lane and drains waiters deterministically. */
export function releaseModelPermit(permitId: string): void {
  const grant = held.get(permitId)
  if (!grant) return
  held.delete(permitId)
  if (heldByCall.get(grant.callId) === permitId) heldByCall.delete(grant.callId)
  drainWaiters()
}

/** Release by call identity (the finally path owns the callId, not the
 *  permitId, across fallback re-entries). Idempotent. */
export function releaseModelPermitByCall(callId: string): void {
  const permitId = heldByCall.get(callId)
  if (permitId !== undefined) releaseModelPermit(permitId)
}

/** Proof seam — governor state is process-lifetime. */
export function _resetCapacityGovernorForTesting(): void {
  if (waiters.length > 0) {
    logForDebugging(`[capacity] reset with ${waiters.length} waiter(s) — proof teardown`)
    waiters.length = 0
  }
  held.clear()
  heldByCall.clear()
  ceilings = { ...DEFAULT_CEILINGS }
  permitSeq = 0
}

/** Proof seam — read the raw composed state without copying semantics. */
export function _governorStateForTesting(): { held: number; delegated: number; waiters: number } {
  return { held: held.size, delegated: heldDelegated(), waiters: waiters.length }
}
