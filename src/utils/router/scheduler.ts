import {
  ROUTE_NODE_SETTLED,
  type RouteNode,
  type RoutePlanState,
  type TaskRoutePlan,
} from './contracts.js'

export const NODE_MAX_ATTEMPTS = 3

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

export function dependencySatisfied(plan: TaskRoutePlan, node: RouteNode): boolean {
  const byId = new Map(plan.nodes.map(n => [n.id, n]))
  return node.dependsOn.every(dep => byId.get(dep)?.state === 'accepted')
}

export function promotableNodes(plan: TaskRoutePlan): string[] {
  return plan.nodes
    .filter(n => n.state === 'blocked' && dependencySatisfied(plan, n))
    .map(n => n.id)
}

export interface SchedulerWorker {
  short: string
  modelClass?: string
  busy: boolean
  modelPinned?: boolean
}

export interface NodeAssignment {
  nodeId: string
  worker: string
  needsReconfigure: boolean
}

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
      needsReconfigure: wanted !== undefined && any.modelClass !== wanted && !any.modelPinned,
    })
  }
  return out
}

export function derivePlanState(plan: TaskRoutePlan): RoutePlanState {
  if (plan.state === 'cancelled' || plan.state === 'accepted') return plan.state
  const nodes = plan.nodes
  if (nodes.some(n => n.state === 'failed')) return 'failed'
  const allAccepted = nodes.length > 0 && nodes.every(n => n.state === 'accepted' || n.state === 'cancelled' || n.state === 'superseded')
  if (allAccepted) return plan.synthesis.required ? 'synthesizing' : 'accepted'
  return 'running'
}

export function generationMaySettle(node: RouteNode, generation: number | undefined): boolean {
  if (node.workerGeneration === undefined || generation === undefined) return true
  return generation >= node.workerGeneration
}

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
