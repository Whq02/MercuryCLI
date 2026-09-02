// ============================================================================
//  workbench/projection — the ONE WorkbenchProjection engine.
//
//  Shape copied from telemetryBus (the estate's composer precedent): one
//  event-driven shared snapshot — refreshes are serialized (a request
//  mid-refresh coalesces into one trailing re-run), triggers are the owning
//  stores' OWN events (telemetry version bumps, run-kernel notifications,
//  execution-plane events), plus a slow heartbeat ONLY while subscribed.
//  Idle with no subscribers the
//  engine is fully off — no timers, no watchers, no token cost anywhere.
//
//  Everything here GATHERS; derivation is the pure selectors module. AppState
//  (runtime tasks' rich fields) is reachable only through the provider seam —
//  headless/adapter contexts without it degrade to the execution-plane
//  mirror, honestly.
// ============================================================================

import { useSyncExternalStore } from 'react'
import { getTelemetry, subscribeTelemetry } from '../../state/telemetryBus.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  readAgentMetadata,
} from '../../utils/sessionStorage/paths.js'
import { asAgentId } from '../../types/ids.js'
import { lastActionWasLeadHandoff } from '../../utils/swarm/teamPhases.js'
import { computeWorkingTreeDigestAsync } from '../../utils/verification/verificationState.js'
import { listReviewArtifactHeadsSource } from '../../utils/artifacts/reviewStore.js'
import { lanesEnabled, listLanesSource } from '../contextLanes/lanes.js'
import {
  classifyReadFailure,
  healthOf,
  mapSourceValue,
  sourceEmpty,
  sourceReady,
  sourceStale,
  sourceUnavailable,
  valueOr,
  type SourceState,
} from '../../substrate/sourceState.js'
import { gitWorktrees } from '../gitGraph/observe.js'
import { subscribeExecutionEvents, listExecutions } from '../primitives/executionPlane.js'
import { getRunSnapshot, subscribeRuns } from '../run/runCoordinator.js'
import { loadRunSidecar } from '../run/runSidecar.js'
import { processMainOwner, processOwnerForLane } from '../run/resolveOwner.js'
import type { RunSnapshot } from '../run/runKernel.js'
import {
  workbenchEnabled,
  WORKBENCH_SOURCES_SCHEMA,
  type WorkbenchSnapshot,
} from './contracts.js'
import { serialCoalescer, type SerialCoalescer } from './serialCoalescer.js'
import { cachedAttentionView } from '../../services/attention/viewModel.js'
import { isAttentionStoreArmed } from '../../services/attention/store.js'
import {
  composeWorkbenchSnapshot,
  type AgentMetaFact,
  type ExecutionFact,
  type RichTaskFact,
  type RunFacts,
  type WorkbenchSourceInputs,
} from './selectors.js'

const REFRESH_DEBOUNCE_MS = 300
const HEARTBEAT_MS = 20_000
const EXECUTIONS_MAX = 100

// ── the AppState provider seam ───────────────────────────────────────────────
// The /workbench board arms this while mounted (resource resolves may pass a
// per-call getAppState that takes precedence); headless/ACP consumers run
// honestly degraded without it.

let appStateProvider: (() => unknown) | null = null

/** (review finding: the eagerly-attached view was one refresh
 *  stale, and a dormant store published needsYou:0 as fact to ACP/resource
 *  readers). The member is a LIVE getter: reads see the CURRENT view — the
 *  one truth — and while no consumer has ever armed the store the member is
 *  ABSENT (undefined), the workbench's honest-absence idiom, never an empty
 *  state masquerading as "nothing needs you". */
function withLiveAttention(snap: WorkbenchSnapshot): WorkbenchSnapshot {
  Object.defineProperty(snap, 'attention', {
    enumerable: true,
    configurable: true,
    get: () => (isAttentionStoreArmed() ? cachedAttentionView() : undefined),
  })
  return snap
}

export function setWorkbenchStateProvider(fn: (() => unknown) | null): void {
  appStateProvider = fn
}

// ── defensive picks (AppState is `unknown` here by design) ───────────────────

function pickRichTasks(state: unknown): Map<string, RichTaskFact> {
  const out = new Map<string, RichTaskFact>()
  if (typeof state !== 'object' || state === null) return out
  const tasks = (state as { tasks?: unknown }).tasks
  if (typeof tasks !== 'object' || tasks === null) return out
  for (const [id, raw] of Object.entries(tasks as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const t = raw as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
    const fact: RichTaskFact = {
      id,
      taskType: str(t.type) ?? 'unknown',
    }
    const description = str(t.description)
    if (description !== undefined) fact.description = description
    const status = str(t.status)
    if (status !== undefined) fact.status = status
    const agentId = str(t.agentId)
    if (agentId !== undefined) fact.agentId = agentId
    const agentType = str(t.agentType)
    if (agentType !== undefined) fact.agentType = agentType
    const model = str(t.model)
    if (model !== undefined) fact.model = model
    const teammateName = str(t.name)
    if (teammateName !== undefined) fact.teammateName = teammateName
    const isIdle = bool(t.isIdle)
    if (isIdle !== undefined) fact.isIdle = isIdle
    const shutdownRequested = bool(t.shutdownRequested)
    if (shutdownRequested !== undefined) fact.shutdownRequested = shutdownRequested
    const awaitingPlanApproval = bool(t.awaitingPlanApproval)
    if (awaitingPlanApproval !== undefined) fact.awaitingPlanApproval = awaitingPlanApproval
    fact.hasProgress = t.progress !== undefined && t.progress !== null
    if (Array.isArray(t.messages)) {
      fact.lastActionWasLeadHandoff = lastActionWasLeadHandoff(t.messages)
    }
    out.set(id, fact)
  }
  return out
}

/** Exported for the momentum parity prover (the F9 law) — production callers
 *  stay inside this module. */
export function pickRunFacts(snap: RunSnapshot | null): RunFacts | null {
  if (!snap) return null
  const facts: RunFacts = {}
  const s = snap as unknown as Record<string, unknown>
  if (typeof s.objective === 'string') facts.objective = s.objective
  if (typeof s.lifecycle === 'string') facts.lifecycle = s.lifecycle
  if (typeof s.phase === 'string') facts.phase = s.phase
  if (typeof s.nextAction === 'string') facts.nextAction = s.nextAction
  // RunBlocker is an OBJECT (description/ownedBy/resumeCondition) — the old
  // typeof-string check could never fire, so the workbench root row never
  // showed the kernel blocker.
  const blocker = s.blocker as { description?: unknown; ownedBy?: unknown } | null | undefined
  if (blocker && typeof blocker.description === 'string') {
    facts.blocker =
      typeof blocker.ownedBy === 'string'
        ? `${blocker.ownedBy}: ${blocker.description}`
        : blocker.description
  }
  if (Array.isArray(s.changedPaths)) {
    facts.changedPaths = s.changedPaths.filter((p): p is string => typeof p === 'string')
  }
  if (typeof s.totalChangedPaths === 'number') facts.totalChangedPaths = s.totalChangedPaths
  const verification = s.verification as { state?: unknown } | undefined
  if (verification && typeof verification.state === 'string') {
    facts.verificationState = verification.state
  }
  return facts
}

// ── agent-metadata sidecar cache (read once per agentId per process) ─────────

const agentMetaCache = new Map<string, AgentMetaFact>()

async function agentMetaFor(agentId: string): Promise<AgentMetaFact | null> {
  const cached = agentMetaCache.get(agentId)
  if (cached) return cached
  try {
    const meta = await readAgentMetadata(asAgentId(agentId))
    if (!meta) return null // NEVER negative-cache: the sidecar may land late
    const fact: AgentMetaFact = {
      ...(meta.agentType !== undefined && { agentType: meta.agentType }),
      ...(meta.worktreePath !== undefined && {
        worktreePath: realpathSafe(meta.worktreePath),
      }),
      ...(meta.model !== undefined && { model: meta.model }),
      ...(meta.effortOverride !== undefined && { effortOverride: meta.effortOverride }),
    }
    agentMetaCache.set(agentId, fact)
    return fact
  } catch {
    return null
  }
}

function realpathSafe(p: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:fs') as typeof import('node:fs')).realpathSync(p)
  } catch {
    return p
  }
}

// ── gather (I/O; bounded; failure-isolated per source) ───────────────────────

export async function gatherWorkbenchInputs(opts?: {
  getAppState?: () => unknown
  /** ENGINE-ONLY: prior good values per source, so a read that fails now can
   *  be reported as stale-with-its-last-value instead of a bare unavailable.
   *  The one-shot resolve deliberately passes nothing — it has no history and
   *  must answer for what it observed on this call alone. */
  lastGood?: Map<string, unknown>
}): Promise<WorkbenchSourceInputs> {
  const now = Date.now()
  const cwd = getCwd()
  const telemetry = getTelemetry()
  const owner = processMainOwner()

  const executions: ExecutionFact[] = listExecutions(owner, { limit: EXECUTIONS_MAX }).map(r => {
    const fact: ExecutionFact = {
      id: r.spec.id,
      kind: String(r.spec.kind),
      label: r.spec.label,
      state: String(r.state),
      updatedAt: r.updatedAt,
    }
    if (typeof (r as unknown as { startedAt?: unknown }).startedAt === 'number') {
      fact.startedAt = (r as unknown as { startedAt: number }).startedAt
    }
    if (r.spec.metadata) fact.metadata = r.spec.metadata
    const outputRef = (r as unknown as { outputRef?: unknown }).outputRef
    if (typeof outputRef === 'string') fact.outputRef = outputRef
    return fact
  })

  const stateFn = opts?.getAppState ?? appStateProvider
  let richTasks = new Map<string, RichTaskFact>()
  if (stateFn) {
    try {
      richTasks = pickRichTasks(stateFn())
    } catch (e) {
      logForDebugging(`[workbench] state provider threw (degrading): ${e}`)
    }
  }

  const agentMeta = new Map<string, AgentMetaFact>()
  const laneRuns = new Map<string, RunFacts>()
  await Promise.all(
    [...richTasks.values()]
      .filter(t => t.agentId)
      .map(async t => {
        const meta = await agentMetaFor(t.agentId!)
        if (meta) agentMeta.set(t.agentId!, meta)
        try {
          const run = pickRunFacts(getRunSnapshot(processOwnerForLane(t.agentId!)))
          if (run) laneRuns.set(t.id, run)
        } catch {
          /* lane owner resolution is best-effort */
        }
      }),
  )

  let treeDigest: string | null = null
  try {
    treeDigest = await computeWorkingTreeDigestAsync(cwd)
  } catch {
    treeDigest = null
  }

  let sessionId: string | null = null
  try {
    sessionId = getSessionId()
  } catch {
    sessionId = null
  }

  // A projection-only process (the ACP server, a resource resolve in a
  // process that never hosted the turns) holds no in-memory run — fall back
  // to a READ-ONLY sidecar load so the editor answers the same run facts the
  // TUI shows instead of an optimistic nothing.
  let mainRunSnap = getRunSnapshot(owner)
  if (mainRunSnap === null) {
    try {
      const load = await loadRunSidecar(owner)
      if (load.state === 'loaded') mainRunSnap = load.snapshot
    } catch {
      /* absent/unreadable — the honest null stands */
    }
  }

  // The three sources whose failure is otherwise indistinguishable from
  // emptiness are observed ONCE here, so the flattened
  // collection below and the health row beside it can never disagree.
  const artifactsSrc = remember(opts?.lastGood, 'artifacts', listArtifactHeadFacts(cwd))
  const contextLanesSrc = remember(
    opts?.lastGood,
    'contextLanes',
    listContextLaneFacts(sessionId),
  )
  const gitWorktreesSrc = remember(opts?.lastGood, 'gitWorktrees', listGitWorktreeLanes(cwd))

  return {
    now,
    projectRoot: cwd,
    sessionId,
    generation: {
      ...(treeDigest !== null && { treeDigest }),
      ...(telemetry.git?.commitHash !== undefined && { headSha: telemetry.git.commitHash }),
      ...(telemetry.git?.branchName !== undefined && { branch: telemetry.git.branchName }),
      ...(telemetry.git?.isClean !== undefined && { clean: telemetry.git.isClean }),
    },
    executions,
    mainRun: pickRunFacts(mainRunSnap),
    richTasks,
    agentMeta,
    laneRuns,
    contextLanes: valueOr(contextLanesSrc, []),
    workflowsDisk: telemetry.workflowsDisk.map(w => ({
      runId: w.runId,
      status: w.status,
      ...(w.title !== undefined && { title: w.title }),
      agentCount: w.agentCount,
    })),
    crew: telemetry.crew,
    artifacts: valueOr(artifactsSrc, []),
    gitWorktreeLanes: valueOr(gitWorktreesSrc, []),
    sources: {
      schema: WORKBENCH_SOURCES_SCHEMA,
      artifacts: healthOf(artifactsSrc),
      contextLanes: healthOf(contextLanesSrc),
      gitWorktrees: healthOf(gitWorktreesSrc),
    },
  }
}

/**
 * Engine-only last-known-good: when a source that previously READ turns
 * unavailable, report it STALE — the prior value plus the reason, with its age
 * derivable from observedAt — rather than as a bare failure that erases what
 * we know. `store` is undefined for the one-shot resolve, which holds no
 * history and must answer honestly; that is also what keeps the
 * reproducer deterministic.
 */
function remember<T>(
  store: Map<string, unknown> | undefined,
  id: string,
  s: SourceState<T>,
): SourceState<T> {
  if (!store) return s
  if (s.state === 'ready') {
    store.set(id, s.value)
    return s
  }
  // A source that read cleanly and holds nothing RETIRES its last-known-good:
  // continuing to show deleted rows as "stale" would be the same lie in the
  // other direction.
  if (s.state === 'empty') {
    store.delete(id)
    return s
  }
  const prior = store.get(id)
  return prior === undefined ? s : sourceStale(prior as T, s.reason)
}

function listGitWorktreeLanes(
  cwd: string,
): SourceState<WorkbenchSourceInputs['gitWorktreeLanes']> {
  try {
    const worktrees = gitWorktrees(cwd)
    if (!Array.isArray(worktrees)) {
      // The observer ALREADY hands back a typed unavailable (not a repo, or
      // the git call failed). Collapsing that into `[]` — "this project has no
      // worktrees" — was defect H's fourth site: the truth was in hand and
      // thrown away one line later.
      return sourceUnavailable(worktrees.note, false)
    }
    const lanes = worktrees
      .filter(w => !w.isMain)
      .slice(0, 20)
      .map(w => ({
        path: realpathSafe(w.path),
        ...(w.branch !== null && { branch: w.branch }),
        head: w.head,
      }))
    return lanes.length === 0 ? sourceEmpty() : sourceReady(lanes)
  } catch (e) {
    return classifyReadFailure(e)
  }
}

function listArtifactHeadFacts(cwd: string): SourceState<WorkbenchSourceInputs['artifacts']> {
  // The store is home-scoped; the WORKBENCH is project-scoped — an unfiltered
  // enumeration leaks another project's review queue into this one and pins
  // nextAction forever (verify wave, UI finding 3).
  return mapSourceValue(listReviewArtifactHeadsSource({ root: cwd }), heads =>
    heads.map(h => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      latestVersion: h.latestVersion,
      status: h.status,
      ...(h.treeDigest !== undefined && { treeDigest: h.treeDigest }),
      openComments: h.openComments,
      updatedAt: h.updatedAt,
    })),
  )
}

function listContextLaneFacts(
  sessionId: string | null,
): SourceState<WorkbenchSourceInputs['contextLanes']> {
  // A disabled gate is not an emptiness either — the source was never
  // consulted. Surfaces render this one QUIETLY (it is a standing condition,
  // not a fault); if it ever reads as noisy, suppress it at the consumer
  // rather than lying about the state here.
  if (!lanesEnabled()) {
    return sourceUnavailable('context lanes are disabled (MERCURY_LANES=0)', false)
  }
  return mapSourceValue(
    listLanesSource(sessionId ? { parentSessionId: sessionId } : undefined),
    lanes =>
      lanes.map(l => ({
        id: l.id,
        goal: l.goal,
        status: l.status,
        childSessionId: l.childSessionId,
        ...(l.handoff !== undefined && { handoffPromoted: l.handoff.promoted }),
        ...(l.handoff !== undefined && { handoffReturnedAt: l.handoff.returnedAt }),
      })),
  )
}

// ── the engine (telemetryBus shape) ──────────────────────────────────────────

let snapshot: WorkbenchSnapshot | null = null
/** Last successfully observed value per source (engine scope only) — the
 *  history that lets a failed read degrade to `stale` rather than erasing what
 *  the operator was already looking at. */
const lastGood = new Map<string, unknown>()
const listeners = new Set<() => void>()
let heartbeat: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const engineUnsubs: Array<() => void> = []
/** Minted per engine start, released in stopEngine — released lanes are
 *  terminal, so reusing one across a stop/start would silently never run
 *  again. Null while the engine is off, which is also what makes
 *  pokeWorkbench a no-op there. */
let coalescer: SerialCoalescer | null = null

function emit(): void {
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[workbench] listener threw (ignored): ${e}`)
    }
  }
}

async function refreshOnce(): Promise<void> {
  // Stamped at gather START, so the value the snapshot carries names the
  // newest trigger this gather actually observed. The lane's trailing-run
  // guarantee is what makes the FINAL snapshot's stamp equal the last accepted
  // trigger: a poke landing mid-gather bumps the generation and earns its own
  // gather, which then stamps the newer number.
  const gatherGeneration = coalescer?.generation() ?? 0
  const inputs = await gatherWorkbenchInputs({ lastGood })
  snapshot = withLiveAttention({
    ...composeWorkbenchSnapshot(inputs, snapshot),
    gatherGeneration,
  })
  emit()
}

/** Refresh now (serialized; a request mid-refresh coalesces into one re-run). */
export function pokeWorkbench(): void {
  if (listeners.size === 0) return
  coalescer?.poke()
}

function scheduleDebounced(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    pokeWorkbench()
  }, REFRESH_DEBOUNCE_MS)
  debounceTimer.unref?.()
}

function startEngine(): void {
  if (heartbeat) return
  // The catch stays INSIDE the run body: a failed gather is logged and the
  // lane still counts the generation as done, which is exactly what the
  // inlined do/while did. Letting it reject instead would park the lane in
  // `degraded` and change what an unrelated later poke means.
  coalescer = serialCoalescer(async () => {
    try {
      await refreshOnce()
    } catch (e) {
      logForDebugging(`[workbench] refresh failed (dropped): ${e}`)
    }
  }, 'workbench')
  heartbeat = setInterval(() => pokeWorkbench(), HEARTBEAT_MS)
  heartbeat.unref?.()
  engineUnsubs.push(subscribeTelemetry(() => scheduleDebounced()))
  engineUnsubs.push(subscribeRuns(() => scheduleDebounced()))
  engineUnsubs.push(subscribeExecutionEvents(() => scheduleDebounced()))
  pokeWorkbench() // initial fill
}

function stopEngine(): void {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  // Release is TERMINAL — a released lane starts no further run — so the
  // handle is dropped and startEngine mints a fresh one. Keeping it would
  // leave the engine permanently silent after its first stop.
  coalescer?.release()
  coalescer = null
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  for (const unsub of engineUnsubs.splice(0)) {
    try {
      unsub()
    } catch {
      /* unsubscribe is best-effort */
    }
  }
}

/** The cached shared snapshot (stable reference between refreshes). */
export function getWorkbenchSnapshot(): WorkbenchSnapshot | null {
  return snapshot
}

export function subscribeWorkbench(listener: () => void): () => void {
  if (!workbenchEnabled()) return () => {}
  listeners.add(listener)
  startEngine()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopEngine()
  }
}

/** Subscribe a component to the shared workbench snapshot. */
export function useWorkbench(): WorkbenchSnapshot | null {
  return useSyncExternalStore(subscribeWorkbench, getWorkbenchSnapshot, getWorkbenchSnapshot)
}

/**
 * One-shot compose for non-subscribing consumers (the resource adapter, ACP):
 * reuses the engine's snapshot when the engine is live; otherwise gathers
 * once with the caller's AppState (no timers armed, nothing retained).
 */
export async function resolveWorkbenchSnapshot(opts?: {
  getAppState?: () => unknown
}): Promise<WorkbenchSnapshot | null> {
  if (!workbenchEnabled()) return null
  if (snapshot && listeners.size > 0) return snapshot
  const gatherOpts = opts?.getAppState ? { getAppState: opts.getAppState } : undefined
  const inputs = await gatherWorkbenchInputs(gatherOpts)
  // One-shot resolves must not report the SAME version for different
  // content — advance a shared counter so resource stamps stay honest.
  const composed = withLiveAttention(
    composeWorkbenchSnapshot(inputs, { version: oneShotVersion }),
  )
  oneShotVersion = composed.version
  return composed
}

let oneShotVersion = 0

/**
 * TEST-ONLY: the engine's live resources, for the lifecycle census (the
 * fileStore `_statsForProofs` precedent). Counts and flags only — never state
 * the engine acts on, so reading it cannot change behaviour.
 */
export function _statsForProofs(): {
  listeners: number
  heartbeat: boolean
  debounceTimer: boolean
  engineUnsubs: number
  coalescer: boolean
  lastGood: number
} {
  return {
    listeners: listeners.size,
    heartbeat: heartbeat !== null,
    debounceTimer: debounceTimer !== null,
    engineUnsubs: engineUnsubs.length,
    coalescer: coalescer !== null,
    lastGood: lastGood.size,
  }
}

/** TEST-ONLY: reset engine state between prover scenarios. */
export function _resetWorkbenchForTesting(): void {
  stopEngine()
  listeners.clear()
  snapshot = null
  lastGood.clear()
  agentMetaCache.clear()
  appStateProvider = null
}
