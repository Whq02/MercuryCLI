// ============================================================================
//  primitives/executionPlane — the canonical owner-scoped execution registry
//
//
//  ONE registry answers "what is running, for whom, in what state" across
//  every domain (services, workshop runtimes, tasks, workflow workers, debug
//  adapters, language servers, model turns). The plane owns lifecycle
//  MECHANICS: legal-graph enforcement, monotonic generations, ordered
//  events, bounded retention, disposal, reconciliation plumbing. It owns NO
//  domain truth: it never spawns, never kills, and never decides whether an
//  external process is alive — domains register observers/reconcilers that
//  provide that truth (Law 6), and readiness/evaluation/business logic stays
//  in the domain (services keep readiness; workshop keeps evaluation).
//
//  Records are bounded in-memory state (OwnerScopedStore + settled-record
//  ring). Durable truth stays domain-owned (service records, run sidecars);
//  the plane is the shared PROJECTION every consumer reads — which is why a
//  domain record and its plane record disagreeing is a doctor-visible defect
// not a merge policy.
// ============================================================================

import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  canTransitionExecution,
  EXECUTION_CONTRACT_VERSION,
  ExecutionTransitionError,
  isTerminalExecutionState,
  type ExecutionEvent,
  type ExecutionExternalIdentity,
  type ExecutionKind,
  type ExecutionOutcome,
  type ExecutionRecord,
  type ExecutionSpec,
  type ExecutionState,
} from './execution.js'

/** Settled records retained per owner (oldest settled evicted first). */
const SETTLED_RING_CAP = 128

interface OwnerExecutions {
  records: Map<string, ExecutionRecord>
  /** Monotonic per (owner, spec.id) generation memory — survives record
   *  eviction so a re-registered id can never repeat a generation. */
  generations: Map<string, number>
  eventSeq: number
}

const store = new OwnerScopedStore<OwnerExecutions>({
  name: 'execution-plane',
  create: () => ({ records: new Map(), generations: new Map(), eventSeq: 0 }),
  dispose: (state, owner) => {
    // Owner teardown: every record leaves the registry. Live records emit a
    // final disposed event so subscribers never see an owner vanish silently.
    for (const record of state.records.values()) {
      emit(owner, { type: 'disposed', record })
    }
    state.records.clear()
    state.generations.clear()
  },
  cap: 64,
})
registerOwnerScopedStore(store)

// ── events ──────────────────────────────────────────────────────────────────

export interface OrderedExecutionEvent {
  owner: OwnerKey
  seq: number
  event: ExecutionEvent
}

type ExecutionSubscriber = (event: OrderedExecutionEvent) => void
const subscribers = new Set<ExecutionSubscriber>()

export function subscribeExecutionEvents(cb: ExecutionSubscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

function emit(owner: OwnerKey, event: ExecutionEvent): void {
  const owned = store.peek(owner)
  const seq = owned ? ++owned.eventSeq : 0
  for (const cb of subscribers) {
    try {
      cb({ owner, seq, event })
    } catch {
      /* subscriber errors never break the plane */
    }
  }
}

// ── domain observers (stop + reconcile truth) ───────────────────────────────

/** A domain's answer for one apparently-live record: the OBSERVED state
 *  (Law 6), or null when the domain cannot answer right now. */
export type ExecutionReconciler = (
  record: ExecutionRecord,
) => { state: ExecutionState; outcome?: ExecutionOutcome; reason?: string } | null

/** A domain's stop hook: begin stopping the real thing. The plane records
 *  intent ('stopping'); the domain settles the record when reality settles. */
export type ExecutionStopHandler = (record: ExecutionRecord) => void

interface DomainHooks {
  reconcile?: ExecutionReconciler
  requestStop?: ExecutionStopHandler
}

// §DEPS-TDZ: domains register from their own modules; an import cycle can
// evaluate such a module before this one's body.
// eslint-disable-next-line no-var
var domainHooksMap: Map<ExecutionKind, DomainHooks> | undefined
function domainHooks(): Map<ExecutionKind, DomainHooks> {
  return (domainHooksMap ??= new Map())
}

export function registerExecutionDomain(kind: ExecutionKind, hooks: DomainHooks): void {
  domainHooks().set(kind, hooks)
}

export function executionDomainKinds(): ExecutionKind[] {
  return [...domainHooks().keys()].sort()
}

// ── core operations ─────────────────────────────────────────────────────────

export class ExecutionRegistrationError extends Error {
  constructor(id: string, state: ExecutionState) {
    super(
      `execution '${id}' is still live ('${state}') — settle it before ` +
        `registering a new generation (restart = settle, then register)`,
    )
    this.name = 'ExecutionRegistrationError'
  }
}

export class ExecutionGenerationError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(
      `stale generation for execution '${id}': caller holds gen ${expected}, ` +
        `the record is gen ${actual} — re-read before acting`,
    )
    this.name = 'ExecutionGenerationError'
  }
}

export interface RegisterExecutionInput {
  owner: OwnerKey
  id: string
  kind: ExecutionKind
  label: string
  lifecycle: ExecutionSpec['lifecycle']
  cwd?: string
  startedBy?: string
  metadata?: Record<string, unknown>
  externalIdentity?: ExecutionExternalIdentity
  outputRef?: string
  /** Initial state — 'queued' unless the domain observed a later state at
   *  registration time (must still be a legal ENTRY state, never terminal). */
  initialState?: Extract<ExecutionState, 'queued' | 'starting' | 'running' | 'ready'>
}

/** Register (or re-register after settlement) one execution. Exactly one
 *  live record per (owner, id); generations are monotonic forever. */
export function registerExecution(input: RegisterExecutionInput): ExecutionRecord {
  const owned = store.get(input.owner)
  const existing = owned.records.get(input.id)
  if (existing && !isTerminalExecutionState(existing.state)) {
    throw new ExecutionRegistrationError(input.id, existing.state)
  }
  const generation = (owned.generations.get(input.id) ?? 0) + 1
  owned.generations.set(input.id, generation)
  const now = Date.now()
  const state = input.initialState ?? 'queued'
  const record: ExecutionRecord = {
    spec: {
      version: EXECUTION_CONTRACT_VERSION,
      id: input.id,
      owner: input.owner,
      kind: input.kind,
      label: input.label,
      lifecycle: input.lifecycle,
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      ...(input.startedBy !== undefined && { startedBy: input.startedBy }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    },
    generation,
    state,
    ...(state !== 'queued' && { startedAt: now }),
    updatedAt: now,
    ...(input.externalIdentity !== undefined && { externalIdentity: input.externalIdentity }),
    ...(input.outputRef !== undefined && { outputRef: input.outputRef }),
    evidenceRefs: [],
  }
  owned.records.set(input.id, record)
  pruneSettled(owned)
  emit(input.owner, { type: 'registered', record })
  return record
}

export interface TransitionOptions {
  /** Refuse when the caller's generation is stale (Law 6 honesty). */
  generation?: number
  outcome?: ExecutionOutcome
  externalIdentity?: ExecutionExternalIdentity
  outputRef?: string
  evidenceRefs?: string[]
  /** Marks a reconciliation-derived transition in the emitted event. */
  reconciled?: boolean
}

/**
 * Transition one execution along the legal graph. A repeated transition to
 * the SAME terminal state is idempotent (no event, no error — duplicate
 * terminal observations are normal); any other illegal edge throws typed.
 */
export function transitionExecution(
  owner: OwnerKey,
  id: string,
  to: ExecutionState,
  opts: TransitionOptions = {},
): ExecutionRecord | undefined {
  const owned = store.peek(owner)
  const record = owned?.records.get(id)
  if (!owned || !record) return undefined
  if (opts.generation !== undefined && opts.generation !== record.generation) {
    throw new ExecutionGenerationError(id, opts.generation, record.generation)
  }
  const from = record.state
  if (from === to && isTerminalExecutionState(to)) {
    return record // duplicate terminal observation — idempotent
  }
  if (!canTransitionExecution(from, to)) {
    throw new ExecutionTransitionError(id, from, to)
  }
  const now = Date.now()
  const next: ExecutionRecord = {
    ...record,
    state: to,
    updatedAt: now,
    ...(record.startedAt === undefined && to !== 'queued' && { startedAt: now }),
    ...(isTerminalExecutionState(to) && { settledAt: now }),
    ...(opts.outcome !== undefined && { outcome: opts.outcome }),
    ...(opts.externalIdentity !== undefined && { externalIdentity: opts.externalIdentity }),
    ...(opts.outputRef !== undefined && { outputRef: opts.outputRef }),
    ...(opts.evidenceRefs !== undefined && {
      evidenceRefs: [...record.evidenceRefs, ...opts.evidenceRefs],
    }),
  }
  owned.records.set(id, next)
  if (isTerminalExecutionState(to)) pruneSettled(owned)
  emit(owner, {
    type: 'transition',
    record: next,
    from,
    to,
    ...(opts.reconciled !== undefined && { reconciled: opts.reconciled }),
  })
  return next
}

/** Attach observed facts (identity, output ref, evidence) without a state
 *  change. Terminal records accept evidence refs only. */
export function observeExecution(
  owner: OwnerKey,
  id: string,
  facts: Pick<TransitionOptions, 'externalIdentity' | 'outputRef' | 'evidenceRefs'>,
): ExecutionRecord | undefined {
  const owned = store.peek(owner)
  const record = owned?.records.get(id)
  if (!owned || !record) return undefined
  const terminal = isTerminalExecutionState(record.state)
  const next: ExecutionRecord = {
    ...record,
    updatedAt: Date.now(),
    ...(!terminal && facts.externalIdentity !== undefined && {
      externalIdentity: facts.externalIdentity,
    }),
    ...(!terminal && facts.outputRef !== undefined && { outputRef: facts.outputRef }),
    ...(facts.evidenceRefs !== undefined && {
      evidenceRefs: [...record.evidenceRefs, ...facts.evidenceRefs],
    }),
  }
  owned.records.set(id, next)
  return next
}

/**
 * Request a stop. Mechanical: queued work cancels immediately; live work
 * moves to 'stopping' and the domain's stop handler (when registered) begins
 * stopping the real thing — settlement arrives from the domain later.
 * Already-stopping/terminal records are a no-op.
 */
export function requestStopExecution(owner: OwnerKey, id: string): ExecutionRecord | undefined {
  const record = store.peek(owner)?.records.get(id)
  if (!record) return undefined
  if (isTerminalExecutionState(record.state) || record.state === 'stopping') return record
  if (record.state === 'queued') {
    return transitionExecution(owner, id, 'cancelled', {
      outcome: { reason: 'stop requested before start' },
    })
  }
  const next = transitionExecution(owner, id, 'stopping')
  if (next) {
    try {
      domainHooks().get(record.spec.kind)?.requestStop?.(next)
    } catch {
      /* domain stop errors surface through domain settlement, never here */
    }
  }
  return next
}

/** Settle one execution (terminal states only — typed refusal otherwise). */
export function settleExecution(
  owner: OwnerKey,
  id: string,
  state: ExecutionState,
  opts: Omit<TransitionOptions, 'reconciled'> = {},
): ExecutionRecord | undefined {
  if (!isTerminalExecutionState(state)) {
    throw new ExecutionTransitionError(id, store.peek(owner)?.records.get(id)?.state ?? 'queued', state)
  }
  return transitionExecution(owner, id, state, opts)
}

export interface ReconcileReport {
  owner: OwnerKey
  checked: number
  /** Records a domain reconciler moved (recorded state ≠ observed truth). */
  corrected: { id: string; from: ExecutionState; to: ExecutionState }[]
  /** Live records whose domain could not answer — honestly unverified. */
  unverifiable: string[]
}

/**
 * Reconcile an owner's apparently-live records against domain truth. The
 * plane NEVER claims liveness itself: a domain reconciler answers per
 * record; no reconciler (or a null answer) leaves the record recorded-only
 * and reports it unverifiable (Law 6 — recorded ≠ observed).
 */
export function reconcileExecutions(owner: OwnerKey): ReconcileReport {
  const owned = store.peek(owner)
  const report: ReconcileReport = { owner, checked: 0, corrected: [], unverifiable: [] }
  if (!owned) return report
  for (const record of [...owned.records.values()]) {
    if (isTerminalExecutionState(record.state)) continue
    report.checked++
    const reconciler = domainHooks().get(record.spec.kind)?.reconcile
    if (!reconciler) {
      report.unverifiable.push(record.spec.id)
      continue
    }
    let observed: ReturnType<ExecutionReconciler>
    try {
      observed = reconciler(record)
    } catch {
      report.unverifiable.push(record.spec.id)
      continue
    }
    if (observed === null) {
      report.unverifiable.push(record.spec.id)
      continue
    }
    if (observed.state !== record.state) {
      const moved = transitionExecution(owner, record.spec.id, observed.state, {
        reconciled: true,
        ...(observed.outcome !== undefined && { outcome: observed.outcome }),
      })
      if (moved) {
        report.corrected.push({ id: record.spec.id, from: record.state, to: observed.state })
      }
    }
  }
  return report
}

// ── reads ───────────────────────────────────────────────────────────────────

export function getExecution(owner: OwnerKey, id: string): ExecutionRecord | undefined {
  return store.peek(owner)?.records.get(id)
}

/** True when an id once had records that the settled ring dropped —
 *  `expired`, never `absent` (Law 7). Generation memory outlives eviction. */
export function executionExpired(owner: OwnerKey, id: string): boolean {
  const owned = store.peek(owner)
  if (!owned) return false
  return owned.generations.has(id) && !owned.records.has(id)
}

export interface ListExecutionsOptions {
  kind?: ExecutionKind
  liveOnly?: boolean
  limit?: number
}

/** Bounded listing, newest-updated first. */
export function listExecutions(
  owner: OwnerKey,
  opts: ListExecutionsOptions = {},
): ExecutionRecord[] {
  const owned = store.peek(owner)
  if (!owned) return []
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  return [...owned.records.values()]
    .filter(r => (opts.kind ? r.spec.kind === opts.kind : true))
    .filter(r => (opts.liveOnly ? !isTerminalExecutionState(r.state) : true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

/** Live owners currently holding execution records (doctor census). */
export function executionPlaneCounts(): { owners: number; records: number; live: number } {
  let records = 0
  let live = 0
  for (const owner of store.owners()) {
    const owned = store.peek(owner)
    if (!owned) continue
    records += owned.records.size
    for (const r of owned.records.values()) {
      if (!isTerminalExecutionState(r.state)) live++
    }
  }
  return { owners: store.size, records, live }
}

function pruneSettled(owned: OwnerExecutions): void {
  const settled = [...owned.records.values()]
    .filter(r => isTerminalExecutionState(r.state))
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
  const excess = settled.length - SETTLED_RING_CAP
  for (let i = 0; i < excess; i++) {
    owned.records.delete(settled[i]!.spec.id)
    // generations memory is kept — a re-registered id continues, never repeats
  }
}

/** TEST-ONLY: full reset (proof harnesses). */
export function _resetExecutionPlaneForTesting(): void {
  store.clearAllForShutdown()
  domainHooksMap?.clear()
}
