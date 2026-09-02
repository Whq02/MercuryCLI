// ============================================================================
//  workbench/selectors — PURE derivations from owner facts to workbench rows
// No I/O, no clocks, no stores: everything arrives in
//  WorkbenchSourceInputs and every function is deterministic — the proof
//  suite drives these directly with synthetic owner facts.
// ============================================================================

import {
  deriveTeammatePhase,
  type TeammatePhaseInputs,
} from '../../utils/swarm/teamPhases.js'
import type {
  WorkbenchLaneRow,
  WorkbenchMissionRow,
  WorkbenchSnapshot,
  WorkbenchSources,
  WorkbenchThreadKind,
  WorkbenchThreadRow,
} from './contracts.js'

// ── owner-fact input shapes (small picks of the real owner types) ───────────

/** One execution-plane record (the AppState-tasks mirror + native owners). */
export interface ExecutionFact {
  id: string
  kind: string
  label: string
  state: string
  startedAt?: number
  updatedAt: number
  metadata?: Record<string, unknown>
  outputRef?: string
}

/** Rich per-task facts picked defensively from AppState when the provider
 *  seam is armed (interactive sessions). Absent fields degrade honestly. */
export interface RichTaskFact {
  id: string
  taskType: string
  description?: string
  status?: string
  agentId?: string
  agentType?: string
  model?: string
  teammateName?: string
  isIdle?: boolean
  shutdownRequested?: boolean
  awaitingPlanApproval?: boolean
  hasProgress?: boolean
  lastActionWasLeadHandoff?: boolean
}

/** The run-kernel pick shared by the root row and enriched agent lanes. */
export interface RunFacts {
  objective?: string
  lifecycle?: string
  phase?: string
  nextAction?: string
  blocker?: string
  changedPaths?: string[]
  totalChangedPaths?: number
  verificationState?: string
}

export interface AgentMetaFact {
  agentType?: string
  worktreePath?: string
  model?: string
  effortOverride?: string
}

export interface ContextLaneFact {
  id: string
  goal: string
  status: 'active' | 'returned' | 'dropped'
  childSessionId: string
  handoffPromoted?: boolean
  handoffReturnedAt?: number
}

export interface WorkflowDiskFact {
  runId: string
  title?: string
  status: string
  agentCount?: number
}

export interface CrewFact {
  name: string
  model?: string
  online: boolean
  unread: number
}

/** Review-artifact head facts. */
export interface ArtifactHeadFact {
  id: string
  kind: string
  title: string
  latestVersion: number
  status: string
  treeDigest?: string
  openComments: number
  updatedAt: number
}

export interface WorkbenchSourceInputs {
  now: number
  projectRoot: string
  sessionId: string | null
  /** What the gather actually OBSERVED per source — required, because the
   *  collections below cannot be read honestly without it. */
  sources: WorkbenchSources
  generation: {
    treeDigest?: string
    headSha?: string
    branch?: string
    clean?: boolean
  }
  executions: ExecutionFact[]
  mainRun: RunFacts | null
  /** Keyed by task id — present only when the provider seam is armed. */
  richTasks: Map<string, RichTaskFact>
  /** Keyed by agentId — sidecar metadata where readable. */
  agentMeta: Map<string, AgentMetaFact>
  /** Keyed by task id — per-lane run facts where the kernel has them. */
  laneRuns: Map<string, RunFacts>
  contextLanes: ContextLaneFact[]
  workflowsDisk: WorkflowDiskFact[]
  crew: CrewFact[] | null
  artifacts: ArtifactHeadFact[]
  /** Non-main worktrees from git's own records (restart-surviving lanes). */
  gitWorktreeLanes: Array<{ path: string; branch?: string; head?: string }>
}

// ── thread derivation ────────────────────────────────────────────────────────

const EXECUTION_THREAD_KINDS = new Set(['agent', 'workflow-worker', 'background-job'])

function threadKindOf(exec: ExecutionFact, rich: RichTaskFact | undefined): WorkbenchThreadKind {
  const taskType = rich?.taskType ?? (exec.metadata?.taskType as string | undefined)
  switch (taskType) {
    case 'in_process_teammate':
      return 'teammate'
    case 'local_workflow':
      return 'workflow'
    case 'local_agent':
    case 'remote_agent':
      return 'agent'
    case 'local_bash':
    case 'monitor_mcp':
      return 'job'
    default:
      break
  }
  if (exec.kind === 'workflow-worker') return 'workflow'
  if (exec.kind === 'agent') return 'agent'
  return 'job'
}

function teammatePhaseFrom(rich: RichTaskFact): string {
  const inputs: TeammatePhaseInputs = {
    status: (rich.status ?? 'running') as TeammatePhaseInputs['status'],
    isIdle: rich.isIdle === true,
    shutdownRequested: rich.shutdownRequested === true,
    awaitingPlanApproval: rich.awaitingPlanApproval === true,
    hasProgress: rich.hasProgress === true,
    ...(rich.lastActionWasLeadHandoff !== undefined && {
      lastActionWasLeadHandoff: rich.lastActionWasLeadHandoff,
    }),
  }
  return deriveTeammatePhase(inputs)
}

export function deriveThreadRows(inputs: WorkbenchSourceInputs): WorkbenchThreadRow[] {
  const rows: WorkbenchThreadRow[] = []
  for (const exec of inputs.executions) {
    if (!EXECUTION_THREAD_KINDS.has(exec.kind)) continue
    const rich = inputs.richTasks.get(exec.id)
    const kind = threadKindOf(exec, rich)
    const meta = rich?.agentId ? inputs.agentMeta.get(rich.agentId) : undefined
    const run = inputs.laneRuns.get(exec.id)
    const phase =
      kind === 'teammate' && rich
        ? teammatePhaseFrom(rich)
        : (run?.phase ?? exec.state)
    const refs: string[] = []
    if (exec.outputRef) refs.push(exec.outputRef)
    if (rich?.agentId) refs.push(`mercury://agent/${rich.agentId}`)
    const row: WorkbenchThreadRow = {
      id: exec.id,
      kind,
      title: rich?.description ?? exec.label,
      parentId: 'root',
      ...(rich?.agentId ? { agentId: rich.agentId } : {}),
      phase,
      state: exec.state,
      updatedAt: exec.updatedAt,
      changedPaths: run?.changedPaths ?? [],
      refs,
    }
    const model = rich?.model ?? meta?.model
    if (model) row.model = model
    if (meta?.effortOverride) row.effortOverride = meta.effortOverride
    if (meta?.worktreePath) {
      row.worktreePath = meta.worktreePath
      row.laneId = `wt:${meta.worktreePath}`
    }
    if (exec.startedAt !== undefined) row.startedAt = exec.startedAt
    if (run?.totalChangedPaths !== undefined) row.totalChangedPaths = run.totalChangedPaths
    if (run?.verificationState) row.verification = run.verificationState
    const blocker =
      run?.blocker ??
      (kind === 'teammate' && rich?.awaitingPlanApproval ? 'awaiting plan approval' : undefined)
    if (blocker) row.blocker = blocker
    rows.push(row)
  }
  // Crew teammates (daemon workers) — listed, phase = online/offline truth.
  for (const member of inputs.crew ?? []) {
    const row: WorkbenchThreadRow = {
      id: `crew:${member.name}`,
      kind: 'teammate',
      title: member.name,
      parentId: 'root',
      phase: member.online ? 'working' : 'stopped',
      state: member.online ? 'running' : 'stopped',
      updatedAt: inputs.now,
      changedPaths: [],
      refs: [`mercury://team/${member.name}`],
    }
    if (member.model) row.model = member.model
    if (member.unread > 0) row.blocker = `${member.unread} unread message${member.unread === 1 ? '' : 's'}`
    rows.push(row)
  }
  // Stable order: live first (by recency), then terminal (by recency).
  const terminal = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
  rows.sort((a, b) => {
    const at = terminal.has(a.state) ? 1 : 0
    const bt = terminal.has(b.state) ? 1 : 0
    if (at !== bt) return at - bt
    return b.updatedAt - a.updatedAt
  })
  return rows
}

export function deriveRootRow(inputs: WorkbenchSourceInputs): WorkbenchThreadRow {
  const run = inputs.mainRun
  const row: WorkbenchThreadRow = {
    id: 'root',
    kind: 'root',
    title: run?.objective ?? 'this session',
    phase: run?.phase ?? 'idle',
    state: run?.lifecycle ?? 'idle',
    updatedAt: inputs.now,
    changedPaths: run?.changedPaths ?? [],
    refs: inputs.sessionId
      ? [`mercury://transcript/session/${inputs.sessionId}`, 'mercury://run/current']
      : ['mercury://run/current'],
  }
  if (run?.totalChangedPaths !== undefined) row.totalChangedPaths = run.totalChangedPaths
  if (run?.verificationState) row.verification = run.verificationState
  if (run?.blocker) row.blocker = run.blocker
  return row
}

// ── lane derivation ──────────────────────────────────────────────────────────

/** the ONE lane display-name derivation: goal first (the
 *  operator's words), else the worktree BASENAME (`parcel-081861b96315` — the
 *  distinctive tail an absolute-path id buries), else the lane id. Shared by
 *  the /workbench board rows and /diff's worktree source labels so a lane
 *  reads the same everywhere. */
export function laneDisplayName(args: {
  goal?: string
  worktreePath?: string
  laneId?: string
}): string {
  if (args.goal && args.goal.trim() !== '') return args.goal
  if (args.worktreePath) {
    // Separator-agnostic (win32-seam ratchet): worktree paths can carry
    // either separator; a literal '/' split is a frozen POSIX tell.
    const base = args.worktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (base) return base
  }
  return args.laneId ?? '(lane)'
}

export function deriveLaneRows(inputs: WorkbenchSourceInputs): WorkbenchLaneRow[] {
  const rows: WorkbenchLaneRow[] = []
  for (const lane of inputs.contextLanes) {
    if (lane.status === 'dropped') continue
    rows.push({
      laneId: lane.id,
      displayName: laneDisplayName({ goal: lane.goal, laneId: lane.id }),
      source: 'context-lane',
      status: lane.status,
      goal: lane.goal,
      handoffReady: lane.status === 'returned' && lane.handoffPromoted === false,
      refs: [`mercury://lane/${lane.id}`],
    })
  }
  // Agent/seat worktrees dedupe by path (one lane per worktree).
  const seen = new Set<string>()
  const threadLike: Array<{ id: string; worktreePath?: string; state: string }> = []
  for (const exec of inputs.executions) {
    const rich = inputs.richTasks.get(exec.id)
    const meta = rich?.agentId ? inputs.agentMeta.get(rich.agentId) : undefined
    if (meta?.worktreePath) {
      threadLike.push({ id: exec.id, worktreePath: meta.worktreePath, state: exec.state })
    }
  }
  for (const t of threadLike) {
    if (!t.worktreePath || seen.has(t.worktreePath)) continue
    seen.add(t.worktreePath)
    rows.push({
      laneId: `wt:${t.worktreePath}`,
      displayName: laneDisplayName({ worktreePath: t.worktreePath }),
      source: 'agent-worktree',
      status: t.state,
      worktreePath: t.worktreePath,
      ownerThreadId: t.id,
      refs: [],
    })
  }
  // Worktrees git itself records but no live owner claimed — the lanes a
  // restarted session still sees (and the ones S5 park/cleanup reasons about).
  for (const wt of inputs.gitWorktreeLanes) {
    if (seen.has(wt.path)) continue
    seen.add(wt.path)
    const row: WorkbenchLaneRow = {
      laneId: `wt:${wt.path}`,
      displayName: laneDisplayName({ worktreePath: wt.path }),
      source: 'worktree',
      status: 'present',
      worktreePath: wt.path,
      refs: [],
    }
    if (wt.branch !== undefined) row.branch = wt.branch
    if (wt.head !== undefined) row.headSha = wt.head
    rows.push(row)
  }
  return rows
}

// ── the ONE next action ──────────────────────────────────────────────────────

export function deriveNextAction(args: {
  reviewQueue: WorkbenchSnapshot['reviewQueue']
  root: WorkbenchThreadRow
  threads: WorkbenchThreadRow[]
  lanes: WorkbenchLaneRow[]
  mainRun: RunFacts | null
}): string | null {
  const review = args.reviewQueue[0]
  if (review) return `review: ${review.note}`
  const blocked = args.threads.find(t => t.blocker && t.state === 'running')
  if (blocked) return `answer ${blocked.title}: ${blocked.blocker}`
  const handoff = args.lanes.find(l => l.handoffReady)
  if (handoff) return `adopt lane ${handoff.laneId}${handoff.goal ? ` (${handoff.goal})` : ''}`
  const ready = args.threads.find(t => t.phase === 'handoff-ready')
  if (ready) return `collect handoff from ${ready.title}`
  const failed = args.threads.find(t => t.state === 'failed')
  if (failed) return `inspect failure: ${failed.title}`
  if (args.mainRun?.nextAction) return args.mainRun.nextAction
  return null
}

// ── snapshot assembly (pure) ─────────────────────────────────────────────────

export function composeWorkbenchSnapshot(
  inputs: WorkbenchSourceInputs,
  prior: { version: number } | null,
): WorkbenchSnapshot {
  const root = deriveRootRow(inputs)
  const threads = deriveThreadRows(inputs)
  const lanes = deriveLaneRows(inputs)
  const missions: WorkbenchMissionRow[] = []
  const artifactHeads: WorkbenchSnapshot['artifactHeads'] = inputs.artifacts.map(a => ({
    ref: `mercury://artifact/${a.id}`,
    kind: a.kind,
    title: a.title,
    status: a.status,
    ...(a.treeDigest !== undefined &&
      inputs.generation.treeDigest !== undefined && {
        stale: a.treeDigest !== inputs.generation.treeDigest,
      }),
  }))
  const reviewQueue: WorkbenchSnapshot['reviewQueue'] = []
  for (const a of inputs.artifacts) {
    if (a.openComments > 0) {
      reviewQueue.push({
        ref: `mercury://artifact/${a.id}/comments`,
        note: `${a.title}: ${a.openComments} open comment${a.openComments === 1 ? '' : 's'}`,
      })
    }
    // STALENESS DECAY: a ready-for-review
    // artifact minted on an OLDER tree must not pin the derived next action
    // forever — once the tree moves on, the awaits-review nudge decays (the
    // head still lists it, marked stale). Open comments and explicit
    // revision requests are HUMAN state and never decay.
    const stale =
      a.treeDigest !== undefined &&
      inputs.generation.treeDigest !== undefined &&
      a.treeDigest !== inputs.generation.treeDigest
    if (a.status === 'ready-for-review' && !stale) {
      reviewQueue.push({
        ref: `mercury://artifact/${a.id}`,
        note: `${a.title} v${a.latestVersion} awaits review`,
      })
    }
    if (a.status === 'revision-requested') {
      reviewQueue.push({
        ref: `mercury://artifact/${a.id}`,
        note: `${a.title} v${a.latestVersion} needs revision`,
      })
    }
  }
  return {
    version: (prior?.version ?? 0) + 1,
    refreshedAt: inputs.now,
    projectRoot: inputs.projectRoot,
    generation: inputs.generation,
    root,
    threads,
    lanes,
    missions,
    artifactHeads,
    reviewQueue,
    nextAction: deriveNextAction({
      reviewQueue,
      root,
      threads,
      lanes,
      mainRun: inputs.mainRun,
    }),
    // Carried through verbatim: the gather observed these, and compose stays
    // pure. A collection above is only interpretable next to its row here.
    sources: inputs.sources,
  }
}
