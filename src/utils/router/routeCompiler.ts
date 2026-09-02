import { decideDispatchRoute, normalizeRouteEffort } from '../scribe/dispatchRouter.js'
import {
  ROUTER_POLICY_VERSION,
  ROUTE_PLAN_VERSION,
  type RouteAcceptanceCheck,
  type RouteBand,
  type RouteCompileResult,
  type RouteDecisionRecord,
  type RouteFeatureVector,
  type RouteNode,
  type RouteProfile,
  type RouteReasonCode,
  type RouteTaskShape,
  type TaskRoutePlan,
} from './contracts.js'
import type {
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
} from './providers/types.js'

export const OPUS_AMBIGUITY_BAND: RouteBand = 2
export const OPUS_COUPLING_BAND: RouteBand = 3
export const QUALITY_BAND_SHIFT = 1
export const REVISION_ESCALATION_ATTEMPTS = 2
export const CONTEXT_RENEWAL_PCT = 85
export const PARTY_MAX_WIDTH = 3
export const OUTCOME_MIN_SAMPLES = 5
export const OUTCOME_MAX_WEIGHT = 0.25
export const OUTCOME_POOR_FIRST_PASS = 0.5

export interface RouteCandidateNode {
  id: string
  title: string
  task: string
  dependsOn?: string[]
  ownsPaths?: string[]
  acceptance?: string[]
  requestedModelClass?: RouterModelClass
  expectedResult?: string
}

export interface RouteMissionIntent {
  objective: string
  title: string
  task: string
  taskShape?: RouteTaskShape
  ambiguity?: RouteBand
  coupling?: RouteBand
  parallelism?: RouteBand
  contextDemand?: RouteBand
  verificationDemand?: RouteBand
  candidateNodes?: RouteCandidateNode[]
  modelHint?: RouterModelClass
  exactPin?: string
  requiresSynthesis?: boolean
  preferWorkflow?: boolean
  legacyRoute?: { effort?: string; lane?: string }
  revisionOf?: { nodeId: string; failedAttempts: number }
}

export interface RouteModelPort {
  resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  resolveExact(pin: string): RouteModelRef | null
}

export interface RouteWorkerSnapshot {
  maxWidth: number
  sharedLane: boolean
  currentModelClass?: RouterModelClass
  currentEffort?: string
  contextFillPct?: number
  activeTurn?: boolean
}

export interface RouteOutcomeSnapshot {
  sampleCount: number
  acceptedFirstPassRate: number
}

export interface RouteCompilerInput {
  mode: 'scribe' | 'party'
  intentSource: 'structured' | 'legacy'
  mission: RouteMissionIntent
  posture: RouterPosture
  models: RouteModelPort
  worker: RouteWorkerSnapshot
  outcome?: RouteOutcomeSnapshot
  workflowPostureActive?: boolean
  now: number
  planId: string
}

export const ROUTE_REASON_DISPLAY: Readonly<Partial<Record<RouteReasonCode, string>>> = {
  'mechanical-bounded': 'small, crisply-checked edit — a direct executor lane is enough',
  'bounded-implementation': 'well-specified implementation — executor lane with a review gate',
  'high-ambiguity': 'ambiguity is high — the planner-class model absorbs it',
  'high-coupling': 'tightly entangled state — one deep lane beats a fan-out',
  'diagnostic-unknown-cause': 'unknown root cause — diagnostic work stays on the planner class',
  architectural: 'architectural decision — planner-class judgment required',
  'separable-disjoint-ownership': 'nodes own disjoint changes — safe to run in parallel',
  'ordered-dependencies': 'nodes are separable but ordered — dependency graph',
  'workflow-posture-active': 'the workflow posture is live — delegated to the workflow engine',
  'revision-escalation': 'repeated focused revisions failed — escalated to the planner class',
  'affinity-kept-model': 'the current worker already runs this profile — changeover not worth it',
  'changeover-worth-it': 'expected quality gain exceeds the changeover cost',
  'fallback-local': 'no structured intent — deterministic local fallback routed it',
  'operator-pin': 'operator pin — routed exactly as pinned',
  'history-favors-profile': 'outcome history favors this profile for this task shape',
  'posture-quality': 'quality posture — planner-class bar lowered',
  'posture-fast': 'fast posture — executor preferred for crisp work',
  'exact-pin-unresolvable': 'the pinned model cannot resolve — refused, never aliased',
  'cycle-detected': 'the proposed graph contains a dependency cycle',
  'duplicate-node-ids': 'the proposed graph reuses a node id',
  'overlap-serialized': 'overlapping ownership — execution serialized',
  'width-capped-workers': 'width reduced to the available worker lanes',
  'width-capped-shared-lane': 'shared-directory topology — write-heavy width is 1',
  'provider-unavailable': 'requested provider is not integrated — class fallback applied',
  'workflow-posture-absent': 'workflow posture not active — routed without delegation',
  'empty-acceptance-repaired': 'empty acceptance contract — evidence-report floor injected',
  'context-pressure-renewal': 'context fill is high — renewal advised at the next idle boundary',
  'held-for-idle': 'a turn is in flight — the route applies at the idle boundary',
  'effort-clamped': 'requested effort unsupported — clamped to the nearest supported level',
}

const PATH_RE =
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|md|json|ya?ml|sh|css|scss|html|sql|toml)\b/gi

function bandFromCount(n: number, one: number, two: number, three: number): RouteBand {
  if (n >= three) return 3
  if (n >= two) return 2
  if (n >= one) return 1
  return 0
}

export function deriveFeatureVector(i: RouteCompilerInput): RouteFeatureVector {
  const m = i.mission
  const text = `${m.title}\n${m.task}`
  const paths = [...new Set((text.match(PATH_RE) ?? []).map(s => s.toLowerCase()))]
  const nodeCount = m.candidateNodes?.length ?? 0
  const fallback = decideDispatchRoute(m.task, { title: m.title })
  const shape: RouteTaskShape =
    m.taskShape ??
    (fallback.lane === 'quick' ? 'mechanical' : fallback.lane === 'deep' ? 'cross-cutting' : 'bounded')
  return {
    taskShape: shape,
    ambiguity: m.ambiguity ?? (shape === 'diagnostic' ? 2 : 0),
    coupling: m.coupling ?? (shape === 'cross-cutting' ? 2 : 0),
    parallelism: m.parallelism ?? bandFromCount(nodeCount, 2, 3, 4),
    contextDemand: m.contextDemand ?? bandFromCount(paths.length, 2, 4, 8),
    verificationDemand: m.verificationDemand ?? 1,
    estimatedFiles: Math.max(paths.length, nodeCount),
    explicitPaths: paths,
    requiresSynthesis: m.requiresSynthesis === true || nodeCount > 1,
    ...(m.modelHint ? { modelHint: m.modelHint } : {}),
  }
}

function findCycle(nodes: ReadonlyArray<{ id: string; dependsOn: string[] }>): boolean {
  const state = new Map<string, 0 | 1 | 2>()
  const byId = new Map(nodes.map(n => [n.id, n]))
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0
    if (s === 1) return true
    if (s === 2) return false
    state.set(id, 1)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true
    }
    state.set(id, 2)
    return false
  }
  return nodes.some(n => visit(n.id))
}

function ownershipOverlaps(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map(p => p.toLowerCase()))
  return b.some(p => set.has(p.toLowerCase()))
}

function ancestorSets(
  nodes: ReadonlyArray<{ id: string; dependsOn: string[] }>,
): Map<string, Set<string>> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const memo = new Map<string, Set<string>>()
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const done = memo.get(id)
    if (done) return done
    const out = new Set<string>()
    if (!stack.has(id)) {
      stack.add(id)
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (!byId.has(dep)) continue
        out.add(dep)
        for (const a of visit(dep, stack)) out.add(a)
      }
      stack.delete(id)
    }
    memo.set(id, out)
    return out
  }
  for (const n of nodes) visit(n.id, new Set())
  return memo
}

export function computeUsefulWidth(
  nodes: ReadonlyArray<Pick<RouteNode, 'id' | 'dependsOn' | 'ownsPaths'>>,
  worker: Pick<RouteWorkerSnapshot, 'maxWidth' | 'sharedLane'>,
): { width: number; overlapSerialized: boolean } {
  const roots = nodes.filter(n => n.dependsOn.length === 0)
  const chosen: (typeof roots)[number][] = []
  for (const n of roots) {
    if (chosen.some(c => ownershipOverlaps(c.ownsPaths, n.ownsPaths))) continue
    chosen.push(n)
  }
  const ancestors = ancestorSets(nodes.map(n => ({ id: n.id, dependsOn: n.dependsOn })))
  let overlapSerialized = false
  for (let a = 0; a < nodes.length && !overlapSerialized; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const na = nodes[a]!
      const nb = nodes[b]!
      const ordered = ancestors.get(na.id)?.has(nb.id) || ancestors.get(nb.id)?.has(na.id)
      if (!ordered && ownershipOverlaps(na.ownsPaths, nb.ownsPaths)) {
        overlapSerialized = true
        break
      }
    }
  }
  let width = Math.max(1, Math.min(chosen.length, worker.maxWidth))
  if (worker.sharedLane && width > 1) width = 1
  return { width, overlapSerialized }
}

const DEFAULT_ACCEPTANCE: RouteAcceptanceCheck = {
  id: 'evidence-report',
  description:
    'Return a typed completion: changed-area summary, checks run with results, unresolved items. A bare "done" is a report, not acceptance.',
  kind: 'report',
}

function toAcceptance(list: string[] | undefined, nodeId: string): RouteAcceptanceCheck[] {
  if (!list || list.length === 0) return []
  return list.map((d, ix) => ({ id: `${nodeId}-a${ix + 1}`, description: d, kind: 'report' as const }))
}

function effortFor(modelClass: RouterModelClass, mode: 'scribe' | 'party', profile: RouteProfile): RouteEffortLevel {
  if (modelClass === 'opus') {
    return mode === 'scribe' && profile === 'opus-direct' ? 'max' : 'xhigh'
  }
  return 'high'
}

export function compileRoute(i: RouteCompilerInput): RouteCompileResult {
  const decisive: RouteReasonCode[] = []
  const adjustments: RouteReasonCode[] = []
  const features = deriveFeatureVector(i)
  const m = i.mission

  const refuse = (codes: RouteReasonCode[], detail: string): RouteCompileResult => ({
    ok: false,
    refusal: { refused: true, reasonCodes: codes, detail },
  })

  const rawNodes: RouteCandidateNode[] =
    m.candidateNodes && m.candidateNodes.length > 0
      ? m.candidateNodes
      : [
          {
            id: 'n1',
            title: m.title || m.objective,
            task: m.task,
            ownsPaths: features.explicitPaths,
            acceptance: [],
          },
        ]
  const ids = new Set<string>()
  for (const n of rawNodes) {
    if (ids.has(n.id)) {
      return refuse(['duplicate-node-ids'], `node id '${n.id}' appears more than once`)
    }
    ids.add(n.id)
  }
  for (const n of rawNodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) {
        return refuse(['cycle-detected'], `node '${n.id}' depends on unknown node '${dep}'`)
      }
    }
  }
  const graph = rawNodes.map(n => ({ id: n.id, dependsOn: n.dependsOn ?? [] }))
  if (findCycle(graph)) {
    return refuse(['cycle-detected'], 'the proposed graph contains a dependency cycle')
  }

  let pinnedRef: RouteModelRef | null = null
  if (m.exactPin) {
    pinnedRef = i.models.resolveExact(m.exactPin)
    if (!pinnedRef) {
      return refuse(
        ['exact-pin-unresolvable'],
        `exact model pin '${m.exactPin}' cannot resolve on any available provider`,
      )
    }
    decisive.push('operator-pin')
  }

  const multi = rawNodes.length > 1
  const hasDeps = rawNodes.some(n => (n.dependsOn ?? []).length > 0)
  const { width, overlapSerialized } = computeUsefulWidth(
    rawNodes.map(n => ({ id: n.id, dependsOn: n.dependsOn ?? [], ownsPaths: n.ownsPaths ?? [] })),
    i.worker,
  )
  const qualityShift = i.posture === 'quality' ? QUALITY_BAND_SHIFT : 0
  const opusAmbiguity = features.ambiguity >= OPUS_AMBIGUITY_BAND - qualityShift
  const opusCoupling = features.coupling >= OPUS_COUPLING_BAND - qualityShift

  let profile: RouteProfile
  if (i.posture === 'fixed') {
    profile = multi ? 'dependency-graph' : 'opus-direct'
    decisive.push('operator-pin')
  } else if (m.revisionOf && m.revisionOf.failedAttempts >= REVISION_ESCALATION_ATTEMPTS) {
    profile = 'opus-direct'
    decisive.push('revision-escalation')
  } else if (features.taskShape === 'diagnostic') {
    profile = 'opus-direct'
    decisive.push('diagnostic-unknown-cause')
  } else if (features.taskShape === 'architectural' || features.taskShape === 'research') {
    profile = 'opus-direct'
    decisive.push('architectural')
  } else if (!multi && opusAmbiguity) {
    profile = 'opus-direct'
    decisive.push('high-ambiguity')
    if (qualityShift > 0) decisive.push('posture-quality')
  } else if (!multi && opusCoupling) {
    profile = 'opus-direct'
    decisive.push('high-coupling')
    if (qualityShift > 0) decisive.push('posture-quality')
  } else if (
    m.preferWorkflow === true &&
    i.mode === 'scribe' &&
    i.workflowPostureActive === true
  ) {
    profile = 'workflow-delegated'
    decisive.push('workflow-posture-active')
  } else if (multi && hasDeps) {
    profile = 'dependency-graph'
    decisive.push('ordered-dependencies')
    if (overlapSerialized) adjustments.push('overlap-serialized')
  } else if (multi) {
    decisive.push('separable-disjoint-ownership')
    if (overlapSerialized) {
      profile = 'dependency-graph'
      adjustments.push('overlap-serialized')
    } else if (i.worker.sharedLane) {
      profile = 'dependency-graph'
      adjustments.push('width-capped-shared-lane')
    } else {
      profile = 'parallel-sonnet'
      if (width < Math.min(rawNodes.length, PARTY_MAX_WIDTH)) adjustments.push('width-capped-workers')
    }
  } else if (features.taskShape === 'mechanical') {
    profile = 'sonnet-direct'
    decisive.push('mechanical-bounded')
  } else if (i.posture === 'fast' && features.verificationDemand <= 1 && features.ambiguity === 0) {
    profile = 'sonnet-direct'
    decisive.push('mechanical-bounded', 'posture-fast')
  } else {
    profile = 'sonnet-opus-review'
    decisive.push('bounded-implementation')
  }
  if (m.preferWorkflow === true && profile !== 'workflow-delegated') {
    adjustments.push('workflow-posture-absent')
  }

  if (i.intentSource === 'legacy') {
    decisive.push('fallback-local')
    const legacyEffort = normalizeRouteEffort(m.legacyRoute?.effort)
    if (legacyEffort === 'max' && profile !== 'opus-direct' && i.posture !== 'fixed') {
      profile = 'opus-direct'
    }
  }

  let prior: RouteDecisionRecord['priorContribution']
  if (i.outcome && i.outcome.sampleCount >= OUTCOME_MIN_SAMPLES && i.posture !== 'fixed') {
    prior = {
      sampleCount: i.outcome.sampleCount,
      acceptedFirstPassRate: i.outcome.acceptedFirstPassRate,
      weight: OUTCOME_MAX_WEIGHT,
    }
    if (
      i.outcome.acceptedFirstPassRate < OUTCOME_POOR_FIRST_PASS &&
      profile === 'sonnet-direct'
    ) {
      profile = 'sonnet-opus-review'
      decisive.push('history-favors-profile')
    }
  }

  const defaultClass: RouterModelClass = profile === 'opus-direct' ? 'opus' : 'sonnet'
  const selectedModels: RouteModelRef[] = []
  const compiledNodes: RouteNode[] = []
  for (const n of rawNodes) {
    let cls: RouterModelClass = n.requestedModelClass ?? features.modelHint ?? defaultClass
    let ref = pinnedRef ?? i.models.resolve(cls, i.posture)
    if (!ref && (cls === 'gpt' || cls === 'glm')) {
      if (!adjustments.includes('provider-unavailable')) adjustments.push('provider-unavailable')
      cls = defaultClass
      ref = i.models.resolve(cls, i.posture)
    }
    if (!ref) {
      return refuse(
        ['provider-unavailable'],
        `no available provider can resolve model class '${cls}'`,
      )
    }
    const effort = effortFor(ref.modelClass, i.mode, profile)
    const finalRef: RouteModelRef = pinnedRef ? ref : { ...ref, effort }
    selectedModels.push(finalRef)
    const acceptance = toAcceptance(n.acceptance, n.id)
    if (acceptance.length === 0) {
      if (!adjustments.includes('empty-acceptance-repaired')) adjustments.push('empty-acceptance-repaired')
      acceptance.push({ ...DEFAULT_ACCEPTANCE, id: `${n.id}-${DEFAULT_ACCEPTANCE.id}` })
    }
    compiledNodes.push({
      id: n.id,
      title: n.title,
      task: n.task,
      dependsOn: n.dependsOn ?? [],
      ownsPaths: n.ownsPaths ?? [],
      acceptance,
      assignedModel: finalRef,
      state: (n.dependsOn ?? []).length === 0 ? 'ready' : 'blocked',
      attempt: 1,
      expectedResult: n.expectedResult ?? 'a typed completion satisfying every acceptance check',
      ...(n.requestedModelClass ? { requestedModelClass: n.requestedModelClass } : {}),
    })
  }

  let workerAffinity: RouteDecisionRecord['workerAffinity']
  const primaryClass = selectedModels[0]?.modelClass
  if (i.worker.currentModelClass && primaryClass && i.posture !== 'fixed' && !pinnedRef) {
    if (i.worker.currentModelClass === primaryClass) {
      decisive.push('affinity-kept-model')
      workerAffinity = {
        keptCurrentModel: true,
        changeoverPenalty: 0,
        reason: 'current worker already runs the selected class',
      }
    } else {
      const strong =
        profile === 'opus-direct' ||
        compiledNodes.some(n => n.requestedModelClass !== undefined) ||
        i.intentSource === 'legacy'
      if (strong) {
        decisive.push('changeover-worth-it')
        workerAffinity = {
          keptCurrentModel: false,
          changeoverPenalty: 1,
          reason: 'decisive signal outweighs the fresh-process cost',
        }
      } else {
        const kept = i.models.resolve(i.worker.currentModelClass, i.posture)
        if (kept) {
          decisive.push('affinity-kept-model')
          workerAffinity = {
            keptCurrentModel: true,
            changeoverPenalty: 0,
            reason: 'candidate advantage below the changeover threshold',
          }
          for (const n of compiledNodes) {
            if (!n.requestedModelClass) {
              n.assignedModel = { ...kept, effort: effortFor(kept.modelClass, i.mode, profile) }
            }
          }
        }
      }
    }
  }

  if ((i.worker.contextFillPct ?? 0) >= CONTEXT_RENEWAL_PCT) adjustments.push('context-pressure-renewal')
  if (i.worker.activeTurn === true) adjustments.push('held-for-idle')

  const synthesisRequired =
    features.requiresSynthesis || profile === 'parallel-sonnet' || profile === 'dependency-graph'
  const decision: RouteDecisionRecord = {
    policyVersion: ROUTER_POLICY_VERSION,
    source: m.exactPin ? 'operator-pin' : i.intentSource === 'legacy' ? 'local-fallback' : 'structured-intent',
    posture: i.posture,
    selectedProfile: profile,
    selectedModels,
    decisiveReasons: [...new Set(decisive)],
    displayReasons: [...new Set(decisive)].map(c => ROUTE_REASON_DISPLAY[c] ?? c),
    adjustments: [...new Set(adjustments)],
    ...(workerAffinity ? { workerAffinity } : {}),
    ...(prior ? { priorContribution: prior } : {}),
  }

  const plan: TaskRoutePlan = {
    version: ROUTE_PLAN_VERSION,
    id: i.planId,
    revision: 1,
    mode: i.mode,
    title: m.title || m.objective,
    objective: m.objective,
    features,
    profile,
    nodes: compiledNodes,
    synthesis: {
      required: synthesisRequired,
      owner: i.mode === 'scribe' ? 'scribe' : 'router',
      acceptance: synthesisRequired
        ? [
            {
              id: 'synthesis-integrated',
              description:
                'All required nodes accepted; integrated result assembled from the typed completion packets.',
              kind: 'report',
            },
          ]
        : [],
    },
    decision,
    state: 'committed',
    createdAt: i.now,
    updatedAt: i.now,
  }
  return { ok: true, plan }
}
