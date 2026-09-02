// ============================================================================
//  routerRunStore — the durable route state (plans · nodes · attempts ·
//  event echoes) on the FileStore kernel (locked RMW · atomic publish ·
//  validate-on-read · subscribe).
//
//  TWO writers by design — the planning process commits plans; the DAEMON
//  settles nodes from CAPTURED bus signals; the foreground settles the
//  reports a worker sends back (the daemon never sees a worker's outbound
//  progress). The FileStore's locked cross-process RMW is what makes that
//  safe.
//
//  Lifecycle law lives HERE (not in callers):
//    - transitions ride the ALLOWED table below; an illegal transition is a
//      refused no-op with an event echo, never a corrupt state;
//    - duplicate events are idempotent (same target state ⇒ no-op);
//    - an OLD worker generation can never settle a NEWER attempt's delivery
//      (generationMaySettle);
//    - acceptance is terminal for an attempt; a revision is an EXPLICIT new
//      attempt (bounded by NODE_MAX_ATTEMPTS), never a silent re-run;
//    - accepting a node PROMOTES its dependents (blocked → ready) in the same
//      locked mutation — the DAG advances from recorded acceptance only;
//    - a plan with an invalid persisted row is dropped ROW-wise on read
//      (decodeTaskRoutePlan is all-or-nothing per plan, per-plan drop for the
//      file) with the store's own read-failure warning — never silently
//      emptied (the damaged-store doctrine).
// ============================================================================
import { join } from 'node:path'
import {
  decodeTaskRoutePlan,
  type RouteNode,
  type RouteNodeState,
  type RoutePlannerRole,
  type TaskRoutePlan,
} from '../utils/router/contracts.js'
import { NODE_MAX_ATTEMPTS, derivePlanState, promotableNodes } from '../utils/router/scheduler.js'
import { parseCompletionDetail } from '../utils/router/contextCapsule.js'
import { defineStore } from './fileStore.js'
import { recordRouteOutcome } from './routerOutcomeStore.js'
import { routerStateDir } from './routerPaths.js'

export { routerStateDir } from './routerPaths.js'

const PLAN_RING_READ_CAP = 24
const PLAN_RING_WRITE_CAP = 32
const EVENT_RING_CAP = 120
const EVENT_REASON_CAP = 200

/** Mission-wide replan cap: total revisions across ONE plan.
 *  Per-node attempts stay bounded by NODE_MAX_ATTEMPTS; this bounds the
 *  plan-level churn ("cap mission-wide replan cycles to a small explicit
 *  number"). */
export const MISSION_REPLAN_CEILING = 6

export interface RouteEventEcho {
  ts: number
  planId: string
  nodeId?: string
  from: string
  to: string
  reason?: string
  requestId?: string
}

export interface RouterRunState {
  plans: TaskRoutePlan[]
  events: RouteEventEcho[]
  updatedAt: number
}

/** ALLOWED node transitions (the table IS the law; everything else refuses). */
export const NODE_TRANSITIONS: Readonly<Record<RouteNodeState, readonly RouteNodeState[]>> = {
  blocked: ['ready', 'cancelled', 'superseded'],
  ready: ['held', 'dispatched', 'cancelled', 'superseded'],
  // held ← dispatched: the bridge parks a written dispatch through a worker
  // reconfigure (model/effort change at the idle boundary) — it delivers on
  // the next pass, so held → delivered is the release edge. working/reported
  // are legal FROM dispatched/held because a progress report referencing the
  // routed request id is itself EVIDENCE of delivery — the delivered-observer
  // can race or be lost, and losing a real completion to a missing
  // intermediate state would be the worse lie.
  held: ['ready', 'dispatched', 'delivered', 'working', 'reported', 'cancelled'],
  // 'ready' here is the RECONCILE requeue (a dispatch that never durably
  // delivered retries from its persisted envelope); 'held' is the bridge's
  // reconfigure park. The only backward edges.
  dispatched: ['delivered', 'held', 'working', 'reported', 'ready', 'failed', 'cancelled', 'superseded'],
  delivered: ['working', 'reported', 'failed', 'cancelled'],
  working: ['reported', 'failed', 'cancelled'],
  reported: ['accepted', 'failed', 'cancelled', 'superseded'],
  accepted: [],
  failed: [],
  cancelled: [],
  superseded: [],
}

function decodeEvent(raw: unknown): RouteEventEcho | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.ts !== 'number' || typeof r.planId !== 'string') return null
  if (typeof r.from !== 'string' || typeof r.to !== 'string') return null
  return {
    ts: r.ts,
    planId: r.planId,
    from: r.from,
    to: r.to,
    ...(typeof r.nodeId === 'string' ? { nodeId: r.nodeId } : {}),
    ...(typeof r.reason === 'string' ? { reason: r.reason.slice(0, EVENT_REASON_CAP) } : {}),
    ...(typeof r.requestId === 'string' ? { requestId: r.requestId } : {}),
  }
}

export const routerRunStore = defineStore<RouterRunState, []>({
  name: 'routerRun',
  schemaVersion: 1,
  path: () => join(routerStateDir(), 'plans.json'),
  onReadFailure: 'empty',
  // Cross-process readers (the /router board, the deck route card) subscribe
  // to daemon/tool writes; the poll floor keeps them honest on platforms
  // where rename watches drop deliveries (the fileStore poll-floor class).
  pollFloorMs: 2000,
  empty: () => ({ plans: [], events: [], updatedAt: 0 }),
  decode: raw => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    const plans = Array.isArray(r.plans)
      ? r.plans.map(decodeTaskRoutePlan).filter((p): p is TaskRoutePlan => p !== null).slice(-PLAN_RING_READ_CAP)
      : []
    const events = Array.isArray(r.events)
      ? r.events.map(decodeEvent).filter((e): e is RouteEventEcho => e !== null).slice(-EVENT_RING_CAP)
      : []
    return {
      plans,
      events,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    }
  },
})

// ── Writers (locked RMW; never throw — a route-state write must never take a
//    worker or the planning turn down) ────────────────────────────────────────
async function safeMutate(fn: (s: RouterRunState) => RouterRunState): Promise<void> {
  try {
    await routerRunStore().mutate(current => fn(current))
  } catch {
    // the store's own read-failure warn covers discoverability
  }
}

function echo(s: RouterRunState, e: RouteEventEcho): RouterRunState {
  return { ...s, events: [...s.events, e].slice(-EVENT_RING_CAP) }
}

function withPlan(
  s: RouterRunState,
  planId: string,
  fn: (plan: TaskRoutePlan) => TaskRoutePlan,
): RouterRunState {
  const plan = s.plans.find(p => p.id === planId)
  if (!plan) return s
  return { ...s, plans: s.plans.map(p => (p.id === planId ? fn(p) : p)) }
}

/** Apply a guarded node transition inside a plan; refusals echo, never corrupt. */
function transitionNodeIn(
  plan: TaskRoutePlan,
  s: RouterRunState,
  nodeId: string,
  to: RouteNodeState,
  now: number,
  opts?: {
    reason?: string
    requestId?: string
    generation?: number
    patch?: Partial<RouteNode>
  },
): { plan: TaskRoutePlan; state: RouterRunState; applied: boolean } {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node) return { plan, state: s, applied: false }
  if (node.state === to) return { plan, state: s, applied: false } // idempotent duplicate
  // Generation fence: an old worker generation cannot settle the current attempt.
  if (
    opts?.generation !== undefined &&
    node.workerGeneration !== undefined &&
    opts.generation < node.workerGeneration
  ) {
    return {
      plan,
      state: echo(s, {
        ts: now,
        planId: plan.id,
        nodeId,
        from: node.state,
        to: `refused:${to}`,
        reason: `stale generation ${opts.generation} < ${node.workerGeneration}`,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      }),
      applied: false,
    }
  }
  if (!NODE_TRANSITIONS[node.state].includes(to)) {
    return {
      plan,
      state: echo(s, {
        ts: now,
        planId: plan.id,
        nodeId,
        from: node.state,
        to: `refused:${to}`,
        reason: 'illegal transition',
        ...(opts?.requestId ? { requestId: opts.requestId } : {}),
      }),
      applied: false,
    }
  }
  const nextNode: RouteNode = { ...node, ...(opts?.patch ?? {}), state: to }
  let nextPlan: TaskRoutePlan = {
    ...plan,
    nodes: plan.nodes.map(n => (n.id === nodeId ? nextNode : n)),
    updatedAt: now,
  }
  // Acceptance promotes dependents in the SAME mutation (the DAG advances from
  // recorded acceptance only).
  if (to === 'accepted') {
    const promote = new Set(promotableNodes(nextPlan))
    if (promote.size > 0) {
      nextPlan = {
        ...nextPlan,
        nodes: nextPlan.nodes.map(n => (promote.has(n.id) ? { ...n, state: 'ready' as const } : n)),
      }
    }
  }
  nextPlan = { ...nextPlan, state: derivePlanState(nextPlan) }
  const nextState = echo(
    { ...s, plans: s.plans.map(p => (p.id === plan.id ? nextPlan : p)), updatedAt: now },
    {
      ts: now,
      planId: plan.id,
      nodeId,
      from: node.state,
      to,
      ...(opts?.reason ? { reason: opts.reason.slice(0, EVENT_REASON_CAP) } : {}),
      ...(opts?.requestId ? { requestId: opts.requestId } : {}),
    },
  )
  return { plan: nextPlan, state: nextState, applied: true }
}

export const routerStoreWriters = {
  /** Commit a compiled plan (state 'committed' → immediately 'running'). */
  commitPlan(plan: TaskRoutePlan, now: number): Promise<void> {
    return safeMutate(s => {
      if (s.plans.some(p => p.id === plan.id)) return s // idempotent re-commit
      const committed: TaskRoutePlan = { ...plan, state: 'running', updatedAt: now }
      return echo(
        {
          ...s,
          plans: [...s.plans, committed].slice(-PLAN_RING_WRITE_CAP),
          updatedAt: now,
        },
        { ts: now, planId: plan.id, from: 'none', to: 'running', reason: `committed rev ${plan.revision}` },
      )
    })
  },

  /** Node → dispatched: the EXACT outbound envelope identity is persisted (by
   *  request id) BEFORE the mailbox write is attempted — the outbox record a
   *  restart retries from. Returns whether the transition APPLIED: a racing
   *  second dispatcher gets `false` (ready→dispatched already happened) and
   *  MUST NOT write its envelope — double-dispatch is structurally impossible. */
  async nodeDispatched(
    planId: string,
    nodeId: string,
    busRequestId: string,
    worker: string,
    generation: number | undefined,
    now: number,
  ): Promise<boolean> {
    let applied = false
    await safeMutate(s => {
      const plan = s.plans.find(p => p.id === planId)
      if (!plan) return s
      const r = transitionNodeIn(plan, s, nodeId, 'dispatched', now, {
        requestId: busRequestId,
        patch: {
          busRequestId,
          assignedWorker: worker,
          ...(generation !== undefined ? { workerGeneration: generation } : {}),
        },
      })
      applied = r.applied
      return r.state
    })
    return applied
  },

  /** Planner acceptance keyed by the bus request id (what the daemon sees on
   *  a control ack). */
  async acceptByRequest(busRequestId: string, by: RoutePlannerRole, now: number): Promise<void> {
    const state = await routerRunStore().read().catch(() => null)
    if (!state) return
    for (const plan of state.plans) {
      const node = plan.nodes.find(n => n.busRequestId === busRequestId)
      if (node) {
        await routerStoreWriters.acceptNode(plan.id, node.id, by, now)
        return
      }
    }
  },

  /** Node held at the reconfigure boundary (ready → held / held → ready). */
  nodeHeld(planId: string, nodeId: string, reason: string, now: number): Promise<void> {
    return safeMutate(s => withPlanState(s, planId, nodeId, 'held', now, { reason }))
  },
  nodeReleased(planId: string, nodeId: string, now: number): Promise<void> {
    return safeMutate(s => withPlanState(s, planId, nodeId, 'ready', now))
  },

  /** Observed on the worker's stdin (bridge onDelivered) — keyed by request id. */
  requestDelivered(busRequestId: string, now: number): Promise<void> {
    return safeMutate(s => byRequest(s, busRequestId, 'delivered', now))
  },

  /** progress(working) observed. */
  requestWorking(busRequestId: string, now: number, generation?: number): Promise<void> {
    return safeMutate(s => byRequest(s, busRequestId, 'working', now, { generation }))
  },

  /** progress(done) observed → 'reported' + the typed completion digest.
   *  A detail WITHOUT a parseable typed payload records prose-as-summary with
   *  empty checks — honestly thin, never fabricated. */
  requestReported(busRequestId: string, detail: string | undefined, now: number, generation?: number): Promise<void> {
    return safeMutate(s => {
      const parsed = parseCompletionDetail(detail)
      return byRequest(s, busRequestId, 'reported', now, {
        generation,
        patch: {
          completion: {
            summary: parsed?.summary ?? (detail ?? '').slice(0, 600),
            checksReported: parsed?.checks ?? [],
            changedAreas: parsed?.changedAreas ?? [],
            unresolved: parsed?.unresolved ?? [],
            reportedAt: now,
          },
        },
      })
    })
  },

  /** progress(failed) observed. */
  requestFailed(busRequestId: string, detail: string | undefined, now: number, generation?: number): Promise<void> {
    return safeMutate(s =>
      byRequest(s, busRequestId, 'failed', now, {
        generation,
        reason: (detail ?? 'reported failed').slice(0, EVENT_REASON_CAP),
      }),
    )
  },

  /** The reviewing role ACCEPTS a reported node against its acceptance contract.
   *  A successful acceptance also feeds the bounded outcome memory (firstPass =
   *  accepted on attempt 1) — the ONLY seam that records calibration rows. */
  async acceptNode(planId: string, nodeId: string, by: RoutePlannerRole, now: number): Promise<void> {
    let observed: Parameters<typeof recordRouteOutcome>[0] | null = null
    await safeMutate(s => {
      const plan = s.plans.find(p => p.id === planId)
      const node = plan?.nodes.find(n => n.id === nodeId)
      if (!plan || !node) return s
      const patch: Partial<RouteNode> = node.completion
        ? { completion: { ...node.completion, acceptedBy: by, acceptedAt: now } }
        : {}
      const r = transitionNodeIn(plan, s, nodeId, 'accepted', now, { reason: `accepted by ${by}`, patch })
      if (r.applied) {
        observed = {
          ts: now,
          mode: plan.mode,
          taskShape: plan.features.taskShape,
          ambiguity: plan.features.ambiguity,
          coupling: plan.features.coupling,
          profile: plan.profile,
          modelClass: node.assignedModel?.modelClass ?? 'unknown',
          firstPass: node.attempt === 1,
        }
      }
      return r.state
    })
    if (observed) void recordRouteOutcome(observed)
  },

  /** An explicit focused revision: a NEW bounded attempt under the same
   *  logical node (reported/failed only). Refuses over the attempt ceiling. */
  reviseNode(planId: string, nodeId: string, revisionNote: string, now: number): Promise<void> {
    return safeMutate(s => {
      const plan = s.plans.find(p => p.id === planId)
      const node = plan?.nodes.find(n => n.id === nodeId)
      if (!plan || !node) return s
      if (node.state !== 'reported' && node.state !== 'failed') {
        return echo(s, {
          ts: now,
          planId,
          nodeId,
          from: node.state,
          to: 'refused:revise',
          reason: 'revision is only valid from reported/failed',
        })
      }
      if (node.attempt >= NODE_MAX_ATTEMPTS) {
        return echo(s, {
          ts: now,
          planId,
          nodeId,
          from: node.state,
          to: 'refused:revise',
          reason: `attempt ceiling (${NODE_MAX_ATTEMPTS}) reached`,
        })
      }
      // Mission-wide replan cap: total revisions across
      // the WHOLE plan are bounded — a plan cannot churn forever even when
      // individual nodes stay under their own attempt ceiling.
      const totalRevisions = plan.nodes.reduce((sum, n) => sum + Math.max(0, n.attempt - 1), 0)
      if (totalRevisions >= MISSION_REPLAN_CEILING) {
        return echo(s, {
          ts: now,
          planId,
          nodeId,
          from: node.state,
          to: 'refused:revise',
          reason: `mission replan ceiling (${MISSION_REPLAN_CEILING} total revisions) reached`,
        })
      }
      const revised: RouteNode = {
        ...node,
        state: 'ready',
        attempt: node.attempt + 1,
        task: `${node.task}\n\n[revision ${node.attempt + 1}: ${revisionNote.slice(0, 400)}]`,
      }
      delete (revised as Partial<RouteNode>).busRequestId
      delete (revised as Partial<RouteNode>).workerGeneration
      const nextPlan: TaskRoutePlan = {
        ...plan,
        nodes: plan.nodes.map(n => (n.id === nodeId ? revised : n)),
        state: 'running',
        updatedAt: now,
      }
      return echo(
        { ...s, plans: s.plans.map(p => (p.id === planId ? nextPlan : p)), updatedAt: now },
        { ts: now, planId, nodeId, from: node.state, to: 'ready', reason: `revision attempt ${revised.attempt}` },
      )
    })
  },

  /** Cancel an unstarted node / the whole plan. */
  cancelNode(planId: string, nodeId: string, reason: string, now: number): Promise<void> {
    return safeMutate(s => withPlanState(s, planId, nodeId, 'cancelled', now, { reason }))
  },
  cancelPlan(planId: string, reason: string, now: number): Promise<void> {
    return safeMutate(s =>
      withPlan(
        echo(s, { ts: now, planId, from: 'any', to: 'cancelled', reason: reason.slice(0, EVENT_REASON_CAP) }),
        planId,
        p => ({
          ...p,
          state: 'cancelled',
          nodes: p.nodes.map(n =>
            n.state === 'accepted' || n.state === 'failed' ? n : { ...n, state: 'cancelled' as const },
          ),
          updatedAt: now,
        }),
      ),
    )
  },

  /** Final mission acceptance (synthesis owner). Requires every required node
   *  accepted — refused otherwise (the synthesis gate is mechanical). */
  acceptPlan(planId: string, by: RoutePlannerRole, now: number): Promise<void> {
    return safeMutate(s => {
      const plan = s.plans.find(p => p.id === planId)
      if (!plan) return s
      const derived = derivePlanState(plan)
      if (derived !== 'synthesizing' && derived !== 'accepted') {
        return echo(s, {
          ts: now,
          planId,
          from: plan.state,
          to: 'refused:accepted',
          reason: `not all required nodes are accepted (derived '${derived}')`,
        })
      }
      return echo(
        withPlan(s, planId, p => ({ ...p, state: 'accepted', updatedAt: now })),
        { ts: now, planId, from: plan.state, to: 'accepted', reason: `accepted by ${by}` },
      )
    })
  },
}

/** Shared helper: guarded transition wrapper over (planId, nodeId). */
function withPlanState(
  s: RouterRunState,
  planId: string,
  nodeId: string,
  to: RouteNodeState,
  now: number,
  opts?: Parameters<typeof transitionNodeIn>[5],
): RouterRunState {
  const plan = s.plans.find(p => p.id === planId)
  if (!plan) return s
  return transitionNodeIn(plan, s, nodeId, to, now, opts).state
}

/** Guarded transition keyed by the bus request id (what observers see). */
function byRequest(
  s: RouterRunState,
  busRequestId: string,
  to: RouteNodeState,
  now: number,
  opts?: { generation?: number; reason?: string; patch?: Partial<RouteNode> },
): RouterRunState {
  for (const plan of s.plans) {
    const node = plan.nodes.find(n => n.busRequestId === busRequestId)
    if (node) {
      // 'delivered' may arrive when 'working' already landed (echo path order)
      // — treat as an idempotent duplicate, not an illegal-transition echo.
      // (dispatched|held → delivered are the real edges.)
      if (to === 'delivered' && node.state !== 'dispatched' && node.state !== 'held') return s
      return transitionNodeIn(plan, s, node.id, to, now, { ...opts, requestId: busRequestId }).state
    }
  }
  return s // an unrouted request id — not this store's traffic (never invents a row)
}

// ── Restart reconciliation ───────────────────────────────────────────────────
export interface RouteReconcileObservation {
  /** Durable consumed-dispatch truth (dispatchDedup): 'delivered' | 'delivering' | null. */
  deliveredState: (requestId: string) => Promise<'delivered' | 'delivering' | null>
  /** Live worker generations by short (absent = worker gone). */
  workerGeneration: (short: string) => number | undefined
  now: number
}

/**
 * Boot/engage reconciliation: for every RUNNING plan,
 *   - 'dispatched' whose request was never durably delivered → back to 'ready'
 *     (the exact envelope is re-emittable from the node contract);
 *   - 'dispatched' whose request DID deliver (the mark was lost) → 'delivered';
 *   - 'delivered'/'working' on a RETIRED worker generation → a new bounded
 *     attempt (ready) or 'failed' at the ceiling — with an event echo;
 *   - everything settled is left alone.
 * Emits ONE bounded reconciliation echo per touched node. Never throws.
 */
export async function reconcileRouterRuns(obs: RouteReconcileObservation): Promise<number> {
  let touched = 0
  try {
    const state = await routerRunStore().read()
    for (const plan of state.plans) {
      if (plan.state !== 'running' && plan.state !== 'synthesizing') continue
      for (const node of plan.nodes) {
        if (node.state === 'dispatched' && node.busRequestId) {
          const d = await obs.deliveredState(node.busRequestId).catch(() => null)
          if (d === 'delivered' || d === 'delivering') {
            await routerStoreWriters.requestDelivered(node.busRequestId, obs.now)
          } else {
            await safeMutate(s => withPlanState(s, plan.id, node.id, 'ready', obs.now, { reason: 'reconcile: never delivered — requeued' }))
          }
          touched++
          continue
        }
        if ((node.state === 'delivered' || node.state === 'working') && node.assignedWorker) {
          const gen = obs.workerGeneration(node.assignedWorker)
          if (gen !== undefined && node.workerGeneration !== undefined && gen > node.workerGeneration) {
            if (node.attempt < NODE_MAX_ATTEMPTS) {
              await routerStoreWriters.reviseNode(
                plan.id,
                node.id,
                'worker generation retired mid-attempt; verify current state before redoing work',
                obs.now,
              )
              // reviseNode requires reported/failed — force the fail first when needed.
              const after = await routerRunStore().read()
              const still = after.plans.find(p => p.id === plan.id)?.nodes.find(n => n.id === node.id)
              if (still && (still.state === 'delivered' || still.state === 'working')) {
                await safeMutate(s =>
                  withPlanState(s, plan.id, node.id, 'failed', obs.now, { reason: 'reconcile: worker generation retired' }),
                )
                await routerStoreWriters.reviseNode(plan.id, node.id, 'retried after generation retirement', obs.now)
              }
            } else {
              await safeMutate(s =>
                withPlanState(s, plan.id, node.id, 'failed', obs.now, { reason: 'reconcile: generation retired at attempt ceiling' }),
              )
            }
            touched++
          }
        }
      }
    }
  } catch {
    // reconcile is a recovery net — it must never take the boot down
  }
  return touched
}
