// ============================================================================
//  router/scheduler — code-owned dispatch mechanics over a TaskRoutePlan.
//
//  The model decides SEMANTICS (the graph, ownership, acceptance); this module
//  decides MECHANICS, deterministically:
//    - only dependency-ready nodes are assignable (readiness = recorded
//      predecessor ACCEPTANCE, never elapsed time or prose inference);
//    - one active node per worker; one worker per active node;
//    - simultaneously active nodes never overlap ownership;
//    - shared-lane topology caps write-heavy concurrency at 1;
//    - a lane prefers the worker already configured for the node's model class
//      (changeover only when no matching worker is free);
//    - a failed/retired lane returns its unaccepted node to ready as a NEW
//      attempt (bounded); acceptance is terminal for an attempt;
//    - synthesis unlocks only when every required node is accepted.
//  Pure functions over injected state — no I/O, no clock, no store. The store
//  (routerRunStore) owns persistence + transition guards; the daemon/tool call
//  these to DECIDE, then write through the store.
// ============================================================================
import {
  ROUTE_NODE_SETTLED,
  type RouteNode,
  type RoutePlanState,
  type TaskRoutePlan,
} from './contracts.js'

/** Attempts per logical node before the node is FAILED (visible, bounded). */
export const NODE_MAX_ATTEMPTS = 3

/** States meaning "this node currently occupies a worker lane". */
export const ACTIVE_NODE_STATES: ReadonlySet<RouteNode['state']> = new Set([
  'held',
  'dispatched',
  'delivered',
  'working',
  'reported',
])

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map(p => p.toLowerCase()))
  return b.some(p => set.has(p.toLowerCase()))
}

/** Node ids whose every dependency is accepted. Pure readiness — state is not
 *  consulted (callers filter by state; reconciliation re-derives from scratch). */
export function dependencySatisfied(plan: TaskRoutePlan, node: RouteNode): boolean {
  const byId = new Map(plan.nodes.map(n => [n.id, n]))
  return node.dependsOn.every(dep => byId.get(dep)?.state === 'accepted')
}

/** Promote blocked→ready for every node whose dependencies are now accepted.
 *  Returns the promoted ids (empty = no change). */
export function promotableNodes(plan: TaskRoutePlan): string[] {
  return plan.nodes
    .filter(n => n.state === 'blocked' && dependencySatisfied(plan, n))
    .map(n => n.id)
}

export interface SchedulerWorker {
  /** Worker short ('implementer', 'dps1'…). */
  short: string
  /** The model class the worker currently runs (absent = unknown). */
  modelClass?: string
  busy: boolean
  /** The seat's model axis carries DURABLE OPERATOR INTENT (a persisted/env
   *  slot — precedence: env pin > persisted slot > route > default).
   *  A pinned lane is never reconfigured to a routed class; a mismatched
   *  node it absorbs runs at the pinned class. */
  modelPinned?: boolean
}

export interface NodeAssignment {
  nodeId: string
  worker: string
  /** True when the worker must be reconfigured (model class differs) before
   *  delivery — the caller holds the node through the idle boundary. */
  needsReconfigure: boolean
}

/**
 * Choose the next assignments: ready nodes × free workers, ownership-disjoint
 * against everything already active, affinity-first. Deterministic (node order
 * = plan order; worker order = given order). `sharedLane` caps total active
 * write-heavy nodes at 1 — enforced HERE, not remembered by a prompt.
 */
export function nextAssignments(
  plan: TaskRoutePlan,
  workers: readonly SchedulerWorker[],
  opts?: { sharedLane?: boolean },
): NodeAssignment[] {
  const active = plan.nodes.filter(n => ACTIVE_NODE_STATES.has(n.state))
  if (opts?.sharedLane && active.length >= 1) return []
  const activePaths = active.flatMap(n => n.ownsPaths)
  const busyWorkers = new Set(
    [...workers.filter(w => w.busy).map(w => w.short), ...active.map(n => n.assignedWorker ?? '')].filter(Boolean),
  )
  const freeWorkers = workers.filter(w => !busyWorkers.has(w.short))
  const out: NodeAssignment[] = []
  const claimedPaths: string[] = [...activePaths]
  const claimedWorkers = new Set<string>()
  for (const node of plan.nodes) {
    if (node.state !== 'ready') continue
    if (!dependencySatisfied(plan, node)) continue
    if (overlaps(claimedPaths, node.ownsPaths)) continue
    if (opts?.sharedLane && out.length + active.length >= 1) break
    const wanted = node.assignedModel?.modelClass
    const affinity = freeWorkers.find(w => !claimedWorkers.has(w.short) && w.modelClass === wanted)
    const any = affinity ?? freeWorkers.find(w => !claimedWorkers.has(w.short))
    if (!any) break
    claimedWorkers.add(any.short)
    claimedPaths.push(...node.ownsPaths)
    out.push({
      nodeId: node.id,
      worker: any.short,
      // An operator-pinned lane absorbs a mismatched class instead of being
      // retargeted (suppressing only the patch would hold-loop the node —
      // the reconfigure demand must die HERE, at the assignment).
      needsReconfigure: wanted !== undefined && any.modelClass !== wanted && !any.modelPinned,
    })
  }
  return out
}

/** Derive the plan state from its nodes (the View law: projections only).
 *  - any node failed (attempts exhausted) ⇒ 'failed'
 *  - all nodes settled-accepted + synthesis required ⇒ 'synthesizing' until
 *    the plan itself is accepted by its synthesis owner
 *  - all accepted + no synthesis ⇒ 'accepted'
 *  - otherwise ⇒ 'running' */
export function derivePlanState(plan: TaskRoutePlan): RoutePlanState {
  if (plan.state === 'cancelled' || plan.state === 'accepted') return plan.state
  const nodes = plan.nodes
  if (nodes.some(n => n.state === 'failed')) return 'failed'
  const allAccepted = nodes.length > 0 && nodes.every(n => n.state === 'accepted' || n.state === 'cancelled' || n.state === 'superseded')
  if (allAccepted) return plan.synthesis.required ? 'synthesizing' : 'accepted'
  return 'running'
}

/** True when a completion from `generation` may settle the node — an old
 *  worker generation can NEVER settle a newer attempt's delivery. */
export function generationMaySettle(node: RouteNode, generation: number | undefined): boolean {
  if (node.workerGeneration === undefined || generation === undefined) return true
  return generation >= node.workerGeneration
}

/** Compact width explanation for the UI ("why is the party width 1?"). */
export function explainWidth(
  plan: TaskRoutePlan,
  maxWidth: number,
  sharedLane: boolean,
): string {
  const ready = plan.nodes.filter(n => n.state === 'ready').length
  const active = plan.nodes.filter(n => ACTIVE_NODE_STATES.has(n.state)).length
  if (sharedLane) return 'width 1 — shared-directory lane topology (no worktree isolation)'
  if (plan.nodes.length === 1) return 'width 1 — single-node plan'
  if (ready + active <= 1) return `width ${Math.max(1, active)} — dependency order gates the rest`
  const capped = Math.min(ready + active, maxWidth)
  return `width ${capped} — ${ready + active} runnable node(s), ${maxWidth} lane(s)`
}
