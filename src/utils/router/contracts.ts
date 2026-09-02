// ============================================================================
//  router/contracts — the versioned route-plan contracts + total decoders.
// ----------------------------------------------------------------------------
//  ONE typed routing vocabulary for the route kernel (per-task routing, as
//  distinct from account placement and mode engagement). A TaskRoutePlan is
//  the durable record of one routing decision: what was asked, how it
//  decomposed, which model class executes each node, why — with stable
//  reason CODES (tests assert codes, never prose).
//
//  Compatibility law: decoders are TOTAL. An unknown/corrupt persisted plan
//  decodes to null and the STORE drops that row individually (never the
//  file). New fields are additive-optional, proven backward-safe by
//  scripts/router/.
// ============================================================================
import { createHash } from 'node:crypto'
import type {
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
} from './providers/types.js'

export const ROUTER_POLICY_VERSION = 'router-1'
export const ROUTE_PLAN_VERSION = 1 as const

/** The dispatch topology a plan compiled for: one executor lane worked in
 *  order, or a fan-out over several executor lanes. */
export type RouteTopology = 'sequential' | 'fanout'
export const ROUTE_TOPOLOGIES: readonly RouteTopology[] = ['sequential', 'fanout']

/** The role that plans, accepts nodes and owns synthesis. One member today;
 *  a successor planner extends this owner, never a parallel vocabulary. */
export type RoutePlannerRole = 'planner'

// ── Reason codes (stable, closed — the corpus + UI + tests key on these) ────
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

/** Reason codes the compiler no longer produces (the workflow posture they
 *  named belonged to a retired seat). READ-tolerant only: a persisted record
 *  carrying one still decodes — the decoders filter reasons to the live
 *  vocabulary, so the code drops and the record stays; nothing produces
 *  them (the corpus replay prover pins both halves). */
export const LEGACY_ROUTE_REASON_CODES = ['workflow-posture-active', 'workflow-posture-absent'] as const
export type LegacyRouteReasonCode = (typeof LEGACY_ROUTE_REASON_CODES)[number]

// ── Vocabulary ───────────────────────────────────────────────────────────────
export const ROUTE_PROFILES = [
  'sonnet-direct',
  'sonnet-opus-review',
  'opus-direct',
  'parallel-sonnet',
  'dependency-graph',
] as const
export type RouteProfile = (typeof ROUTE_PROFILES)[number]

/** Profiles the compiler no longer produces (the workflow-delegated one
 *  belonged to a retired seat's workflow posture). READ-tolerant only — a
 *  plan persisted before the retirement still decodes and paints; nothing
 *  selects them (the corpus replay prover pins both halves). */
export const LEGACY_ROUTE_PROFILES = ['workflow-delegated'] as const
export type LegacyRouteProfile = (typeof LEGACY_ROUTE_PROFILES)[number]
/** The READ vocabulary: live profiles plus the legacy ones a persisted plan
 *  may still carry. Producers never consult this. */
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

/** 0-3 bands used across the feature vector. */
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
  /** How the check is meant to be discharged; 'report' = evidence in the typed
   *  completion (the floor every repaired-empty contract gets). */
  kind: 'test' | 'build' | 'grep' | 'render' | 'report'
}

// ── Node lifecycle (captured-signal vocabulary — see recon note) ────────────
export const ROUTE_NODE_STATES = [
  'blocked', // dependencies not yet accepted
  'ready', // assignable now
  'held', // ready but waiting on a worker reconfigure/idle boundary
  'dispatched', // envelope written to the worker inbox (outbox record exists)
  'delivered', // observed on the worker's stdin (bridge onDelivered)
  'working', // progress(working) observed
  'reported', // progress(done) observed — awaiting review/acceptance
  'accepted', // reviewing role ack'd against the acceptance contract
  'failed', // progress(failed) observed / attempts exhausted
  'cancelled', // operator/planner cancel before delivery
  'superseded', // replaced by a newer revision of the same logical node
] as const
export type RouteNodeState = (typeof ROUTE_NODE_STATES)[number]

/** States that end an attempt (the node may still revise into a new attempt). */
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
  /** Exclusive write-ownership claims — disjointness is scheduled, not hoped. */
  ownsPaths: string[]
  acceptance: RouteAcceptanceCheck[]
  requestedModelClass?: RouterModelClass
  assignedModel?: RouteModelRef
  /** Worker short (e.g. 'scout') once assigned. */
  assignedWorker?: string
  state: RouteNodeState
  /** 1-based; a focused revision bumps attempt under the SAME logical node. */
  attempt: number
  contextCapsuleId?: string
  /** The bus request_id of the outbound dispatch for the CURRENT attempt. */
  busRequestId?: string
  /** Worker generation the current attempt was delivered to (stale-settle fence). */
  workerGeneration?: number
  expectedResult: string
  /** Bounded completion evidence from the typed result (observed, never prose-minted). */
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
  /** The compiler selects a live profile; a persisted record may still
   *  carry a legacy one (read-tolerant). */
  selectedProfile: RouteProfile | LegacyRouteProfile
  selectedModels: RouteModelRef[]
  /** Stable codes (asserted by tests) + short display text (for humans). */
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

/** A typed refusal — a plan with no coherent executable form is REFUSED whole,
 *  never partially dispatched. */
export interface RouteRefusal {
  refused: true
  reasonCodes: RouteReasonCode[]
  detail: string
}
export type RouteCompileResult =
  | { ok: true; plan: TaskRoutePlan }
  | { ok: false; refusal: RouteRefusal }

// ── The compact resolved-route header that rides a dispatch envelope ─────────
// The full plan lives in the route store; the envelope carries only identity +
// the resolved target so the daemon can reconfigure without a store read on the
// hot path (it re-validates through seatSlots regardless — fail-closed).
export interface EnvelopeRouteHeader {
  planId: string
  nodeId: string
  revision: number
  attempt: number
  model?: string
  effort?: string
}

// ── Ids + digest ─────────────────────────────────────────────────────────────
let idCounter = 0
export function generateRoutePlanId(now = Date.now()): string {
  return `rp-${now.toString(36)}-${(idCounter++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0')}`
}

/** Stable digest over a canonical (sorted-key) serialization. */
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

// ── Total decoders ───────────────────────────────────────────────────────────
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

/** Total plan decoder: null on ANY structural fault (the store drops the ROW,
 *  never the file — a plan with a missing node is not executable). */
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

/** Decode the compact envelope route header (additive-optional envelope fields). */
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
