//  global lane, service queries — acquires a permit HERE before the provider
import { logForDebugging } from '../../utils/debug.js'

export type PermitLane = 'foreground' | 'background-session' | 'coordinator' | 'service'

export interface PermitRequest {
  lane: PermitLane
  callId: string
  sessionId?: string
}

export interface PermitGrant {
  permitId: string
  callId: string
  lane: PermitLane
  waitedMs: number
  reacquired: boolean
}

interface Waiter {
  req: PermitRequest
  enqueuedAt: number
  resolve: (grant: PermitGrant) => void
}

export interface GovernorCeilings {
  modelLanes: number
  delegationLanes: number
}

const DEFAULT_CEILINGS: GovernorCeilings = { modelLanes: 16, delegationLanes: 16 }

let ceilings: GovernorCeilings = { ...DEFAULT_CEILINGS }
const held = new Map<string, PermitGrant>()
const heldByCall = new Map<string, string>()
const waiters: Waiter[] = []
let permitSeq = 0

export function setGovernorCeilings(next: Partial<GovernorCeilings>): void {
  const lanes = Math.max(1, Math.floor(next.modelLanes ?? ceilings.modelLanes))
  const delegation = Math.max(1, Math.floor(next.delegationLanes ?? ceilings.delegationLanes))
  ceilings = { modelLanes: lanes, delegationLanes: delegation }
  drainWaiters()
}

export function governorCeilings(): GovernorCeilings {
  return { ...ceilings }
}

export function heldPermits(): readonly PermitGrant[] {
  return [...held.values()]
}

function backgroundAllowance(): number {
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

export function releaseModelPermit(permitId: string): void {
  const grant = held.get(permitId)
  if (!grant) return
  held.delete(permitId)
  if (heldByCall.get(grant.callId) === permitId) heldByCall.delete(grant.callId)
  drainWaiters()
}

export function releaseModelPermitByCall(callId: string): void {
  const permitId = heldByCall.get(callId)
  if (permitId !== undefined) releaseModelPermit(permitId)
}

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

export function _governorStateForTesting(): { held: number; delegated: number; waiters: number } {
  return { held: held.size, delegated: heldDelegated(), waiters: waiters.length }
}
