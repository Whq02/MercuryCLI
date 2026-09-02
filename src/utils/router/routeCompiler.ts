// ============================================================================
//  routeCompiler — Opus semantic intent + runtime facts → an executable
//  TaskRoutePlan. Deterministic, pure, hermetically testable: every
//  input is injected (model snapshot, worker snapshot, outcome stats, clock).
// ----------------------------------------------------------------------------
//  Doctrine (the product rules, enforced here as code — not prompt prose):
//    - ONE semantic decision: the planner supplies intent in its existing
//      turn; this compiler validates, enriches, and schedules. Intent that
//      omits a task shape still compiles from bounded text signals, so
//      absent metadata never blocks work.
//    - Opus thinks wide, Sonnet executes narrow; exceptions are RECORDED in
//      the decision (reason codes), never silent.
//    - Width follows SEPARABILITY (disjoint ownership / dependency order),
//      never task size. Shared-lane topology caps write-heavy width at 1.
//    - Every route is explainable: stable reason codes + display text.
//    - A plan with no coherent executable form is a typed REFUSAL — it is
//      never partially dispatched.
//  Policy constants are NAMED + exported (no magic numbers); boundary cases
//  are covered by scripts/router/ (corpus + invariants).
// ============================================================================
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
  type RouteTopology,
  type TaskRoutePlan,
} from './contracts.js'
import type {
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
} from './providers/types.js'

// ── Named policy constants ───────────────────────────────────────────────────
/** Ambiguity band at/above which work is NOT handed to an executor lane. */
export const OPUS_AMBIGUITY_BAND: RouteBand = 2
/** Coupling band at/above which work is NOT handed to an executor lane. */
export const OPUS_COUPLING_BAND: RouteBand = 3
/** Under 'quality' posture the executor bar tightens by one band. */
export const QUALITY_BAND_SHIFT = 1
/** Focused revisions on the same logical node before escalation to Opus. */
export const REVISION_ESCALATION_ATTEMPTS = 2
/** Context fill (pct) at/above which renewal-at-idle is advised. */
export const CONTEXT_RENEWAL_PCT = 85
/** Executor lanes a fan-out topology may use at once. */
export const FANOUT_MAX_WIDTH = 3
/** Minimum outcome samples before history may influence a route. */
export const OUTCOME_MIN_SAMPLES = 5
/** History influence cap — semantic intent stays primary. */
export const OUTCOME_MAX_WEIGHT = 0.25
/** First-pass acceptance below which history nudges the profile toward review. */
export const OUTCOME_POOR_FIRST_PASS = 0.5

// ── Inputs ───────────────────────────────────────────────────────────────────
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
  /** An EXACT operator pin (raw model string): resolves or refuses, never aliases. */
  exactPin?: string
  requiresSynthesis?: boolean
  preferWorkflow?: boolean
  revisionOf?: { nodeId: string; failedAttempts: number }
}

/** The model-resolution port (RouterModelSnapshot subset — injected). */
export interface RouteModelPort {
  resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  resolveExact(pin: string): RouteModelRef | null
}

export interface RouteWorkerSnapshot {
  /** Concurrent execution lanes actually available (sequential: 1, fanout: ≤FANOUT_MAX_WIDTH). */
  maxWidth: number
  /** Non-git fallback topology: write-heavy width is capped at 1. */
  sharedLane: boolean
  currentModelClass?: RouterModelClass
  currentEffort?: string
  contextFillPct?: number
  /** A turn is in flight — changeover must wait for the idle boundary. */
  activeTurn?: boolean
}

export interface RouteOutcomeSnapshot {
  sampleCount: number
  acceptedFirstPassRate: number
}

export interface RouteCompilerInput {
  mode: RouteTopology
  mission: RouteMissionIntent
  posture: RouterPosture
  models: RouteModelPort
  worker: RouteWorkerSnapshot
  outcome?: RouteOutcomeSnapshot
  now: number
  planId: string
}

// ── Display text for reason codes (UI consumes; tests assert CODES) ─────────
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

// ── Feature derivation ───────────────────────────────────────────────────────
const PATH_RE =
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|md|json|ya?ml|sh|css|scss|html|sql|toml)\b/gi

function bandFromCount(n: number, one: number, two: number, three: number): RouteBand {
  if (n >= three) return 3
  if (n >= two) return 2
  if (n >= one) return 1
  return 0
}

/** Deep-work signals: substantial, multi-step, or risk-bearing work. */
const DEEP_KW =
  /\b(refactor|refactoring|migrat\w*|architect\w*|rewrite|re-?write|redesign|debug\w*|root[- ]?cause|investigat\w*|overhaul|concurren\w*|race[- ]?condition|deadlock|security|vulnerab\w*|audit|optimiz\w*|performance|design\b|algorithm|end[- ]?to[- ]?end)\b/

/** Mechanical signals: a small, well-bounded edit. */
const QUICK_KW =
  /\b(rename|typo|comment|docstring|format\w*|lint|prettier|bump|version|whitespace|reorder imports?|one[- ]?liner|trivial|tweak|nit|rename the|fix the comment|update the comment)\b/

/**
 * The bounded text-signal shape classifier, consulted only when structured
 * intent omits a task shape. Deterministic and cheap: deep keywords, three or
 * more file mentions, or a long spec read as cross-cutting; a quick keyword
 * on a short single-file task reads as mechanical; everything else is
 * bounded. Exported for the corpus proofs.
 */
export function shapeFromTextSignals(task: string, title?: string): RouteTaskShape {
  const text = `${title ?? ''}\n${task ?? ''}`.toLowerCase()
  const len = (task ?? '').length
  const files = new Set((text.match(PATH_RE) ?? []).map(s => s.toLowerCase())).size
  if (DEEP_KW.test(text) || files >= 3 || len >= 600) return 'cross-cutting'
  if (QUICK_KW.test(text) && files <= 1 && len < 220) return 'mechanical'
  return 'bounded'
}

/** Derive the feature vector from intent bands where given, else from bounded
 *  text signals (the fallback path). Missing optional context reduces
 *  confidence and widens conservatively — it never blocks. */
export function deriveFeatureVector(i: RouteCompilerInput): RouteFeatureVector {
  const m = i.mission
  const text = `${m.title}\n${m.task}`
  const paths = [...new Set((text.match(PATH_RE) ?? []).map(s => s.toLowerCase()))]
  const nodeCount = m.candidateNodes?.length ?? 0
  const shape: RouteTaskShape = m.taskShape ?? shapeFromTextSignals(m.task, m.title)
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

// ── Graph validation ─────────────────────────────────────────────────────────
function findCycle(nodes: ReadonlyArray<{ id: string; dependsOn: string[] }>): boolean {
  const state = new Map<string, 0 | 1 | 2>() // 0 unvisited, 1 in-stack, 2 done
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

/** Transitive ancestor sets (id → every id it depends on, transitively). */
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

/** Greedy max set of dependency-free-simultaneous nodes with pairwise-disjoint
 *  ownership, capped by lanes + topology. `overlapSerialized` covers EVERY
 *  concurrently-schedulable pair (neither an ancestor of the other), not just
 *  the initial ready set — two siblings that both become ready after a shared
 *  predecessor still serialize on overlapping ownership. Exported for the
 *  width invariants. */
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

// ── The compile ──────────────────────────────────────────────────────────────
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

function effortFor(modelClass: RouterModelClass, mode: RouteTopology, profile: RouteProfile): RouteEffortLevel {
  if (modelClass === 'opus') {
    // Effort-payoff doctrine: the one deep lane of a sequential plan earns
    // max on opus-direct work; a fan-out lane stays xhigh (the planner's
    // review absorbs the tail).
    return mode === 'sequential' && profile === 'opus-direct' ? 'max' : 'xhigh'
  }
  // Sonnet-5 / fable executor lanes run the ratified seat effort.
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

  // ── Candidate nodes: normalize / repair ────────────────────────────────────
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

  // ── Exact pin: resolves or refuses — never aliases ─────────────────────────
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

  // ── Profile selection ──────────────────────────────────────────────────────
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
    // Fixed = the pinned topology: nothing routes; the seat defaults execute.
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
      if (width < Math.min(rawNodes.length, FANOUT_MAX_WIDTH)) adjustments.push('width-capped-workers')
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

  // ── Outcome history (bounded, capped, never primary) ──────────────────────
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
      // Poor first-pass history on this shape: keep the executor but add the
      // review gate. History may only nudge one step — never skip synthesis,
      // never downgrade.
      profile = 'sonnet-opus-review'
      decisive.push('history-favors-profile')
    }
  }

  // ── Model assignment ───────────────────────────────────────────────────────
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

  // ── Worker affinity / changeover hysteresis ────────────────────────────────
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
      // A class change is a fresh process. It happens ONLY for a strong
      // decisive signal (the opus-direct family / an explicit class request);
      // a merely-preferable candidate keeps the current worker (hysteresis).
      const strong =
        profile === 'opus-direct' ||
        compiledNodes.some(n => n.requestedModelClass !== undefined)
      if (strong) {
        decisive.push('changeover-worth-it')
        workerAffinity = {
          keptCurrentModel: false,
          changeoverPenalty: 1,
          reason: 'decisive signal outweighs the fresh-process cost',
        }
      } else {
        // Weak preference: keep the current class — rewrite assignments.
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

  // ── Boundary adjustments ───────────────────────────────────────────────────
  if ((i.worker.contextFillPct ?? 0) >= CONTEXT_RENEWAL_PCT) adjustments.push('context-pressure-renewal')
  if (i.worker.activeTurn === true) adjustments.push('held-for-idle')

  const synthesisRequired =
    features.requiresSynthesis || profile === 'parallel-sonnet' || profile === 'dependency-graph'
  const decision: RouteDecisionRecord = {
    policyVersion: ROUTER_POLICY_VERSION,
    source: m.exactPin ? 'operator-pin' : 'structured-intent',
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
      owner: 'planner',
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
