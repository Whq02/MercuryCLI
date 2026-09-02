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

export const NODE_TRANSITIONS: Readonly<Record<RouteNodeState, readonly RouteNodeState[]>> = {
  blocked: ['ready', 'cancelled', 'superseded'],
  ready: ['held', 'dispatched', 'cancelled', 'superseded'],
  held: ['ready', 'dispatched', 'delivered', 'working', 'reported', 'cancelled'],
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

async function safeMutate(fn: (s: RouterRunState) => RouterRunState): Promise<void> {
  try {
    await routerRunStore().mutate(current => fn(current))
  } catch {
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
  if (node.state === to) return { plan, state: s, applied: false }
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
  commitPlan(plan: TaskRoutePlan, now: number): Promise<void> {
    return safeMutate(s => {
      if (s.plans.some(p => p.id === plan.id)) return s
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

  nodeHeld(planId: string, nodeId: string, reason: string, now: number): Promise<void> {
    return safeMutate(s => withPlanState(s, planId, nodeId, 'held', now, { reason }))
  },
  nodeReleased(planId: string, nodeId: string, now: number): Promise<void> {
    return safeMutate(s => withPlanState(s, planId, nodeId, 'ready', now))
  },

  requestDelivered(busRequestId: string, now: number): Promise<void> {
    return safeMutate(s => byRequest(s, busRequestId, 'delivered', now))
  },

  requestWorking(busRequestId: string, now: number, generation?: number): Promise<void> {
    return safeMutate(s => byRequest(s, busRequestId, 'working', now, { generation }))
  },

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

  requestFailed(busRequestId: string, detail: string | undefined, now: number, generation?: number): Promise<void> {
    return safeMutate(s =>
      byRequest(s, busRequestId, 'failed', now, {
        generation,
        reason: (detail ?? 'reported failed').slice(0, EVENT_REASON_CAP),
      }),
    )
  },

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
      if (to === 'delivered' && node.state !== 'dispatched' && node.state !== 'held') return s
      return transitionNodeIn(plan, s, node.id, to, now, { ...opts, requestId: busRequestId }).state
    }
  }
  return s
}

export interface RouteReconcileObservation {
  deliveredState: (requestId: string) => Promise<'delivered' | 'delivering' | null>
  workerGeneration: (short: string) => number | undefined
  now: number
}

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
  }
  return touched
}
