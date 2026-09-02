import { createHash } from 'node:crypto'
import type {
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
} from './providers/types.js'

export const ROUTER_POLICY_VERSION = 'router-1'
export const ROUTE_PLAN_VERSION = 1 as const

export type RouteTopology = 'sequential' | 'fanout'
export const ROUTE_TOPOLOGIES: readonly RouteTopology[] = ['sequential', 'fanout']

export type RoutePlannerRole = 'planner'

export const ROUTE_REASON_CODES = [
  'mechanical-bounded',
  'bounded-implementation',
  'high-ambiguity',
  'high-coupling',
  'diagnostic-unknown-cause',
  'architectural',
  'separable-disjoint-ownership',
  'ordered-dependencies',
  'revision-escalation',
  'affinity-kept-model',
  'changeover-worth-it',
  'fallback-local',
  'operator-pin',
  'history-favors-profile',
  'posture-quality',
  'posture-fast',
  'exact-pin-unresolvable',
  'cycle-detected',
  'duplicate-node-ids',
  'overlap-serialized',
  'width-capped-workers',
  'width-capped-shared-lane',
  'provider-unavailable',
  'empty-acceptance-repaired',
  'context-pressure-renewal',
  'held-for-idle',
  'effort-clamped',
] as const
export type RouteReasonCode = (typeof ROUTE_REASON_CODES)[number]
export const isRouteReasonCode = (v: unknown): v is RouteReasonCode =>
  typeof v === 'string' && (ROUTE_REASON_CODES as readonly string[]).includes(v)

export const LEGACY_ROUTE_REASON_CODES = ['workflow-posture-active', 'workflow-posture-absent'] as const
export type LegacyRouteReasonCode = (typeof LEGACY_ROUTE_REASON_CODES)[number]

export const ROUTE_PROFILES = [
  'sonnet-direct',
  'sonnet-opus-review',
  'opus-direct',
  'parallel-sonnet',
  'dependency-graph',
] as const
export type RouteProfile = (typeof ROUTE_PROFILES)[number]

export const LEGACY_ROUTE_PROFILES = ['workflow-delegated'] as const
export type LegacyRouteProfile = (typeof LEGACY_ROUTE_PROFILES)[number]
const isReadableRouteProfile = (v: string): v is RouteProfile | LegacyRouteProfile =>
  (ROUTE_PROFILES as readonly string[]).includes(v) || (LEGACY_ROUTE_PROFILES as readonly string[]).includes(v)

export const ROUTE_TASK_SHAPES = [
  'mechanical',
  'bounded',
  'cross-cutting',
  'diagnostic',
  'architectural',
  'research',
] as const
export type RouteTaskShape = (typeof ROUTE_TASK_SHAPES)[number]

export type RouteBand = 0 | 1 | 2 | 3
const isBand = (v: unknown): v is RouteBand =>
  v === 0 || v === 1 || v === 2 || v === 3

export interface RouteFeatureVector {
  taskShape: RouteTaskShape
  ambiguity: RouteBand
  coupling: RouteBand
  parallelism: RouteBand
  contextDemand: RouteBand
  verificationDemand: RouteBand
  estimatedFiles: number
  explicitPaths: string[]
  requiresSynthesis: boolean
  modelHint?: RouterModelClass
}

export interface RouteAcceptanceCheck {
  id: string
  description: string
  kind: 'test' | 'build' | 'grep' | 'render' | 'report'
}

export const ROUTE_NODE_STATES = [
  'blocked',
  'ready',
  'held',
  'dispatched',
  'delivered',
  'working',
  'reported',
  'accepted',
  'failed',
  'cancelled',
  'superseded',
] as const
export type RouteNodeState = (typeof ROUTE_NODE_STATES)[number]

export const ROUTE_NODE_SETTLED: ReadonlySet<RouteNodeState> = new Set([
  'accepted',
  'failed',
  'cancelled',
  'superseded',
])

export interface RouteNode {
  id: string
  title: string
  task: string
  dependsOn: string[]
  ownsPaths: string[]
  acceptance: RouteAcceptanceCheck[]
  requestedModelClass?: RouterModelClass
  assignedModel?: RouteModelRef
  assignedWorker?: string
  state: RouteNodeState
  attempt: number
  contextCapsuleId?: string
  busRequestId?: string
  workerGeneration?: number
  expectedResult: string
  completion?: RouteNodeCompletion
}

export interface RouteNodeCompletion {
  summary: string
  checksReported: string[]
  changedAreas: string[]
  unresolved: string[]
  reportedAt: number
  acceptedBy?: RoutePlannerRole
  acceptedAt?: number
}

export interface RouteWorkerAffinityRecord {
  keptCurrentModel: boolean
  changeoverPenalty: number
  reason: string
}

export interface RoutePriorContribution {
  sampleCount: number
  acceptedFirstPassRate: number
  weight: number
}

export interface RouteDecisionRecord {
  policyVersion: string
  source: 'structured-intent' | 'local-fallback' | 'operator-pin'
  posture: RouterPosture
  selectedProfile: RouteProfile | LegacyRouteProfile
  selectedModels: RouteModelRef[]
  decisiveReasons: RouteReasonCode[]
  displayReasons: string[]
  adjustments: RouteReasonCode[]
  workerAffinity?: RouteWorkerAffinityRecord
  priorContribution?: RoutePriorContribution
}

export const ROUTE_PLAN_STATES = [
  'committed',
  'running',
  'synthesizing',
  'revising',
  'accepted',
  'failed',
  'cancelled',
] as const
export type RoutePlanState = (typeof ROUTE_PLAN_STATES)[number]

export interface TaskRoutePlan {
  version: typeof ROUTE_PLAN_VERSION
  id: string
  revision: number
  mode: RouteTopology
  title: string
  objective: string
  features: RouteFeatureVector
  profile: RouteProfile | LegacyRouteProfile
  nodes: RouteNode[]
  synthesis: {
    required: boolean
    owner: RoutePlannerRole
    acceptance: RouteAcceptanceCheck[]
  }
  decision: RouteDecisionRecord
  state: RoutePlanState
  createdAt: number
  updatedAt: number
}

export interface RouteRefusal {
  refused: true
  reasonCodes: RouteReasonCode[]
  detail: string
}
export type RouteCompileResult =
  | { ok: true; plan: TaskRoutePlan }
  | { ok: false; refusal: RouteRefusal }

export interface EnvelopeRouteHeader {
  planId: string
  nodeId: string
  revision: number
  attempt: number
  model?: string
  effort?: string
}

let idCounter = 0
export function generateRoutePlanId(now = Date.now()): string {
  return `rp-${now.toString(36)}-${(idCounter++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0')}`
}

export function stableDigest(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = canon((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex').slice(0, 16)
}

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(str) ? (v as string[]) : null

function decodeAcceptance(raw: unknown): RouteAcceptanceCheck[] | null {
  if (!Array.isArray(raw)) return null
  const out: RouteAcceptanceCheck[] = []
  for (const r of raw) {
    if (r === null || typeof r !== 'object') return null
    const c = r as Record<string, unknown>
    if (!str(c.id) || !str(c.description)) return null
    const kind =
      c.kind === 'test' || c.kind === 'build' || c.kind === 'grep' || c.kind === 'render'
        ? c.kind
        : 'report'
    out.push({ id: c.id, description: c.description, kind })
  }
  return out
}

function decodeModelRef(raw: unknown): RouteModelRef | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (
    (r.provider === 'anthropic' || r.provider === 'openai' || r.provider === 'zai') &&
    str(r.model) &&
    (r.modelClass === 'opus' || r.modelClass === 'sonnet' || r.modelClass === 'fable' || r.modelClass === 'gpt' || r.modelClass === 'glm') &&
    (r.effort === 'high' || r.effort === 'xhigh' || r.effort === 'max') &&
    num(r.contextWindow)
  ) {
    return {
      provider: r.provider,
      model: r.model,
      modelClass: r.modelClass as RouterModelClass,
      effort: r.effort as RouteEffortLevel,
      contextWindow: r.contextWindow,
    }
  }
  return undefined
}

function decodeCompletion(raw: unknown): RouteNodeCompletion | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!str(r.summary) || !num(r.reportedAt)) return undefined
  return {
    summary: r.summary,
    checksReported: strArr(r.checksReported) ?? [],
    changedAreas: strArr(r.changedAreas) ?? [],
    unresolved: strArr(r.unresolved) ?? [],
    reportedAt: r.reportedAt,
    ...(r.acceptedBy === 'planner' ? { acceptedBy: r.acceptedBy } : {}),
    ...(num(r.acceptedAt) ? { acceptedAt: r.acceptedAt } : {}),
  }
}

function decodeNode(raw: unknown): RouteNode | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.id) || !str(r.title) || !str(r.task) || !str(r.expectedResult)) return null
  if (!str(r.state) || !(ROUTE_NODE_STATES as readonly string[]).includes(r.state)) return null
  if (!num(r.attempt) || r.attempt < 1) return null
  const dependsOn = strArr(r.dependsOn)
  const ownsPaths = strArr(r.ownsPaths)
  const acceptance = decodeAcceptance(r.acceptance)
  if (dependsOn === null || ownsPaths === null || acceptance === null) return null
  const modelClass =
    r.requestedModelClass === 'opus' ||
    r.requestedModelClass === 'sonnet' ||
    r.requestedModelClass === 'fable' ||
    r.requestedModelClass === 'gpt' ||
    r.requestedModelClass === 'glm'
      ? (r.requestedModelClass as RouterModelClass)
      : undefined
  return {
    id: r.id,
    title: r.title,
    task: r.task,
    dependsOn,
    ownsPaths,
    acceptance,
    state: r.state as RouteNodeState,
    attempt: r.attempt,
    expectedResult: r.expectedResult,
    ...(modelClass ? { requestedModelClass: modelClass } : {}),
    ...(decodeModelRef(r.assignedModel) ? { assignedModel: decodeModelRef(r.assignedModel) } : {}),
    ...(str(r.assignedWorker) ? { assignedWorker: r.assignedWorker } : {}),
    ...(str(r.contextCapsuleId) ? { contextCapsuleId: r.contextCapsuleId } : {}),
    ...(str(r.busRequestId) ? { busRequestId: r.busRequestId } : {}),
    ...(num(r.workerGeneration) ? { workerGeneration: r.workerGeneration } : {}),
    ...(decodeCompletion(r.completion) ? { completion: decodeCompletion(r.completion) } : {}),
  }
}

function decodeFeatures(raw: unknown): RouteFeatureVector | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.taskShape) || !(ROUTE_TASK_SHAPES as readonly string[]).includes(r.taskShape)) return null
  if (!isBand(r.ambiguity) || !isBand(r.coupling) || !isBand(r.parallelism)) return null
  if (!isBand(r.contextDemand) || !isBand(r.verificationDemand)) return null
  if (!num(r.estimatedFiles)) return null
  const explicitPaths = strArr(r.explicitPaths)
  if (explicitPaths === null) return null
  const modelHint =
    r.modelHint === 'opus' || r.modelHint === 'sonnet' || r.modelHint === 'fable' || r.modelHint === 'gpt' || r.modelHint === 'glm'
      ? (r.modelHint as RouterModelClass)
      : undefined
  return {
    taskShape: r.taskShape as RouteTaskShape,
    ambiguity: r.ambiguity,
    coupling: r.coupling,
    parallelism: r.parallelism,
    contextDemand: r.contextDemand,
    verificationDemand: r.verificationDemand,
    estimatedFiles: r.estimatedFiles,
    explicitPaths,
    requiresSynthesis: r.requiresSynthesis === true,
    ...(modelHint ? { modelHint } : {}),
  }
}

function decodeDecision(raw: unknown): RouteDecisionRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.policyVersion)) return null
  if (r.source !== 'structured-intent' && r.source !== 'local-fallback' && r.source !== 'operator-pin') return null
  if (
    r.posture !== 'adaptive' &&
    r.posture !== 'quality' &&
    r.posture !== 'balanced' &&
    r.posture !== 'fast' &&
    r.posture !== 'fixed'
  )
    return null
  if (!str(r.selectedProfile) || !isReadableRouteProfile(r.selectedProfile)) return null
  const models: RouteModelRef[] = []
  if (!Array.isArray(r.selectedModels)) return null
  for (const m of r.selectedModels) {
    const ref = decodeModelRef(m)
    if (!ref) return null
    models.push(ref)
  }
  const decisive = Array.isArray(r.decisiveReasons) ? r.decisiveReasons.filter(isRouteReasonCode) : null
  const adjustments = Array.isArray(r.adjustments) ? r.adjustments.filter(isRouteReasonCode) : null
  const display = strArr(r.displayReasons)
  if (decisive === null || adjustments === null || display === null) return null
  let affinity: RouteWorkerAffinityRecord | undefined
  if (r.workerAffinity && typeof r.workerAffinity === 'object') {
    const a = r.workerAffinity as Record<string, unknown>
    if (typeof a.keptCurrentModel === 'boolean' && num(a.changeoverPenalty) && str(a.reason)) {
      affinity = { keptCurrentModel: a.keptCurrentModel, changeoverPenalty: a.changeoverPenalty, reason: a.reason }
    }
  }
  let prior: RoutePriorContribution | undefined
  if (r.priorContribution && typeof r.priorContribution === 'object') {
    const p = r.priorContribution as Record<string, unknown>
    if (num(p.sampleCount) && num(p.acceptedFirstPassRate) && num(p.weight)) {
      prior = { sampleCount: p.sampleCount, acceptedFirstPassRate: p.acceptedFirstPassRate, weight: p.weight }
    }
  }
  return {
    policyVersion: r.policyVersion,
    source: r.source,
    posture: r.posture,
    selectedProfile: r.selectedProfile as RouteProfile | LegacyRouteProfile,
    selectedModels: models,
    decisiveReasons: decisive,
    displayReasons: display,
    adjustments,
    ...(affinity ? { workerAffinity: affinity } : {}),
    ...(prior ? { priorContribution: prior } : {}),
  }
}

export function decodeTaskRoutePlan(raw: unknown): TaskRoutePlan | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== ROUTE_PLAN_VERSION) return null
  if (!str(r.id) || !num(r.revision) || !str(r.title) || !str(r.objective)) return null
  if (!str(r.mode) || !(ROUTE_TOPOLOGIES as readonly string[]).includes(r.mode)) return null
  if (!str(r.state) || !(ROUTE_PLAN_STATES as readonly string[]).includes(r.state)) return null
  if (!str(r.profile) || !isReadableRouteProfile(r.profile)) return null
  if (!num(r.createdAt) || !num(r.updatedAt)) return null
  const features = decodeFeatures(r.features)
  const decision = decodeDecision(r.decision)
  if (!features || !decision) return null
  if (!Array.isArray(r.nodes)) return null
  const nodes: RouteNode[] = []
  for (const n of r.nodes) {
    const node = decodeNode(n)
    if (!node) return null
    nodes.push(node)
  }
  const s = r.synthesis as Record<string, unknown> | null
  if (s === null || typeof s !== 'object') return null
  if (s.owner !== 'planner') return null
  const synthAcceptance = decodeAcceptance(s.acceptance)
  if (synthAcceptance === null) return null
  return {
    version: ROUTE_PLAN_VERSION,
    id: r.id,
    revision: r.revision,
    mode: r.mode as RouteTopology,
    title: r.title,
    objective: r.objective,
    features,
    profile: r.profile as RouteProfile | LegacyRouteProfile,
    nodes,
    synthesis: { required: s.required === true, owner: s.owner, acceptance: synthAcceptance },
    decision,
    state: r.state as RoutePlanState,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export function decodeEnvelopeRouteHeader(raw: unknown): EnvelopeRouteHeader | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.planId) || !str(r.nodeId) || !num(r.revision) || !num(r.attempt)) return null
  return {
    planId: r.planId,
    nodeId: r.nodeId,
    revision: r.revision,
    attempt: r.attempt,
    ...(str(r.model) ? { model: r.model } : {}),
    ...(str(r.effort) ? { effort: r.effort } : {}),
  }
}
