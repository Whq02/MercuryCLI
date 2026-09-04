
import { useSyncExternalStore } from 'react'
import { getTelemetry } from '../../state/telemetryBus.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getGitState, getGitWorktreeLanes, subscribeGitFacts } from '../../utils/git.js'
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


let appStateProvider: (() => unknown) | null = null

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

export function pickRunFacts(snap: RunSnapshot | null): RunFacts | null {
  if (!snap) return null
  const facts: RunFacts = {}
  const s = snap as unknown as Record<string, unknown>
  if (typeof s.objective === 'string') facts.objective = s.objective
  if (typeof s.lifecycle === 'string') facts.lifecycle = s.lifecycle
  if (typeof s.phase === 'string') facts.phase = s.phase
  if (typeof s.nextAction === 'string') facts.nextAction = s.nextAction
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


const agentMetaCache = new Map<string, AgentMetaFact>()

async function agentMetaFor(agentId: string): Promise<AgentMetaFact | null> {
  const cached = agentMetaCache.get(agentId)
  if (cached) return cached
  try {
    const meta = await readAgentMetadata(asAgentId(agentId))
    if (!meta) return null
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


export async function gatherWorkbenchInputs(opts?: {
  getAppState?: () => unknown
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

  let mainRunSnap = getRunSnapshot(owner)
  if (mainRunSnap === null) {
    try {
      const load = await loadRunSidecar(owner)
      if (load.state === 'loaded') mainRunSnap = load.snapshot
    } catch {
    }
  }

  const artifactsSrc = remember(opts?.lastGood, 'artifacts', listArtifactHeadFacts(cwd))
  const contextLanesSrc = remember(
    opts?.lastGood,
    'contextLanes',
    listContextLaneFacts(sessionId),
  )
  const gitWorktreesSrc = remember(opts?.lastGood, 'gitWorktrees', await listGitWorktreeLanes())

  let git: Awaited<ReturnType<typeof getGitState>> = null
  try {
    git = await getGitState({ untrackedFiles: 'normal' })
  } catch {
    git = null
  }

  return {
    now,
    projectRoot: cwd,
    sessionId,
    generation: {
      ...(treeDigest !== null && { treeDigest }),
      ...(git !== null && { headSha: git.commitHash }),
      ...(git !== null && { branch: git.branchName }),
      ...(git !== null && { clean: git.isClean }),
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
  if (s.state === 'empty') {
    store.delete(id)
    return s
  }
  const prior = store.get(id)
  return prior === undefined ? s : sourceStale(prior as T, s.reason)
}

async function listGitWorktreeLanes(): Promise<SourceState<WorkbenchSourceInputs['gitWorktreeLanes']>> {
  try {
    const worktrees = await getGitWorktreeLanes()
    if (!Array.isArray(worktrees)) {
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


let snapshot: WorkbenchSnapshot | null = null
const lastGood = new Map<string, unknown>()
const listeners = new Set<() => void>()
let heartbeat: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const engineUnsubs: Array<() => void> = []
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
  const gatherGeneration = coalescer?.generation() ?? 0
  const inputs = await gatherWorkbenchInputs({ lastGood })
  snapshot = withLiveAttention({
    ...composeWorkbenchSnapshot(inputs, snapshot),
    gatherGeneration,
  })
  emit()
}

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
  coalescer = serialCoalescer(async () => {
    try {
      await refreshOnce()
    } catch (e) {
      logForDebugging(`[workbench] refresh failed (dropped): ${e}`)
    }
  }, 'workbench')
  heartbeat = setInterval(() => pokeWorkbench(), HEARTBEAT_MS)
  heartbeat.unref?.()
  engineUnsubs.push(subscribeGitFacts(() => scheduleDebounced()))
  engineUnsubs.push(subscribeRuns(() => scheduleDebounced()))
  engineUnsubs.push(subscribeExecutionEvents(() => scheduleDebounced()))
  pokeWorkbench()
}

function stopEngine(): void {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
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
    }
  }
}

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

export function useWorkbench(): WorkbenchSnapshot | null {
  return useSyncExternalStore(subscribeWorkbench, getWorkbenchSnapshot, getWorkbenchSnapshot)
}

export async function resolveWorkbenchSnapshot(opts?: {
  getAppState?: () => unknown
}): Promise<WorkbenchSnapshot | null> {
  if (!workbenchEnabled()) return null
  if (snapshot && listeners.size > 0) return snapshot
  const gatherOpts = opts?.getAppState ? { getAppState: opts.getAppState } : undefined
  const inputs = await gatherWorkbenchInputs(gatherOpts)
  const composed = withLiveAttention(
    composeWorkbenchSnapshot(inputs, { version: oneShotVersion }),
  )
  oneShotVersion = composed.version
  return composed
}

let oneShotVersion = 0

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

export function _resetWorkbenchForTesting(): void {
  stopEngine()
  listeners.clear()
  snapshot = null
  lastGood.clear()
  agentMetaCache.clear()
  appStateProvider = null
}
