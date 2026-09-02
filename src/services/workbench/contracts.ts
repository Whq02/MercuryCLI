// ============================================================================
//  workbench/contracts — the ONE WorkbenchProjection vocabulary.
//
//  hard law: the workbench is a PROJECTION — every field here is
//  derived from an existing owner (execution plane, run kernel, AppState
//  tasks via the provider seam, context lanes,
//  collaboration, telemetryBus, project-intel generation) and none of it is
//  authoritative. There is no workbench store on disk; a row you see here
//  always names the owning surface via mercury:// refs.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SourceHealth } from '../../substrate/sourceState.js'

/** Bumped when the source vocabulary or the tracked set changes. Rides the
 *  WorkbenchSnapshot API boundary — nothing on disk carries it. */
export const WORKBENCH_SOURCES_SCHEMA = 1 as const

/**
 * Per-source read health for the sources whose failure would otherwise be
 * indistinguishable from emptiness. A `[]` on the snapshot
 * means NOTHING until the matching row here says whether the source was read.
 */
export interface WorkbenchSources {
  schema: typeof WORKBENCH_SOURCES_SCHEMA
  artifacts: SourceHealth
  contextLanes: SourceHealth
  gitWorktrees: SourceHealth
}

/** The workbench gate (MERCURY_WORKBENCH in flagRegistry.ts, default-on). */
export function workbenchEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_WORKBENCH'))
}

export type WorkbenchThreadKind =
  | 'root'
  | 'agent'
  | 'teammate'
  | 'workflow'
  | 'seat'
  | 'job'

export interface WorkbenchThreadRow {
  /** Stable id — the execution/task id, seat name, or 'root'. */
  id: string
  kind: WorkbenchThreadKind
  title: string
  parentId?: string
  /** RESOLVED dispatched model where the owner recorded one — never guessed. */
  model?: string
  effortOverride?: string
  /** Phase from the REAL phase owner (teamPhases for teammates, the run
   *  kernel for root, execution-plane state otherwise) — never invented. */
  phase: string
  /** The owning plane's state vocabulary, preserved (execution vocabulary
   *  for task-mirrored threads; crew liveness
   *  for crew rows) — never re-mapped into an invented shared enum. */
  state: string
  laneId?: string
  /** The REAL in-process agent id where the owner recorded one (rich task
   *  facts) — the ONLY id the addressed reply lane may use; row ids
   *  (executions, seat:/crew:) are never drain scopes. */
  agentId?: string
  worktreePath?: string
  startedAt?: number
  updatedAt: number
  /** OBSERVED changed paths (receipts/run kernel) — never prose claims. */
  changedPaths: string[]
  totalChangedPaths?: number
  /** Verification summary state where the owner recorded one. */
  verification?: string
  /** A pending question/approval gate — from the real ask owners. */
  blocker?: string
  latestResultRef?: string
  /** mercury:// refs into the owning surfaces (deep-link, never clone). */
  refs: string[]
}

export type WorkbenchLaneSource =
  | 'context-lane'
  | 'agent-worktree'
  /** A worktree present in git's own records with no live owner attribution
   *  (survives restart — the resume view of lanes). */
  | 'worktree'

export interface WorkbenchLaneRow {
  laneId: string
  /** the human-scannable lane name — goal, else the worktree
   *  BASENAME (the distinctive tail), else the lane id. Derived ONCE in
   *  deriveLaneRows; consumers render this, never re-derive from laneId
   *  (truncate-end on a `wt:<abs path>` id made every row identical). */
  displayName: string
  source: WorkbenchLaneSource
  /** Source-owner status vocabulary (active|returned|dropped|running|…). */
  status: string
  worktreePath?: string
  goal?: string
  ownerThreadId?: string
  branch?: string
  baseSha?: string
  headSha?: string
  /** undefined = not probed (per-lane git state is enriched on demand by the
   *  scoped lane resource, never during a bulk refresh). */
  dirty?: boolean
  /** A returned-but-unpromoted handoff is waiting for adoption. */
  handoffReady?: boolean
  refs: string[]
}

export interface WorkbenchMissionSliceRow {
  id: string
  title: string
  phase: string
  assignee?: string
}

export interface WorkbenchMissionRow {
  id: string
  title: string
  state: string
  slices: WorkbenchMissionSliceRow[]
}

export interface WorkbenchGeneration {
  treeDigest?: string
  headSha?: string
  branch?: string
  clean?: boolean
}

export interface WorkbenchArtifactHead {
  ref: string
  kind: string
  title: string
  status: string
  /** Produced on an older tree than the current generation. */
  stale?: boolean
}

export interface WorkbenchReviewItem {
  ref: string
  note: string
}

export interface WorkbenchSnapshot {
  /** Monotonic per-process refresh counter. */
  version: number
  /** The coalescer generation this gather observed. Absent
   *  on one-shot resolves, which run outside the engine and so have no
   *  trigger lineage to name. Process-scoped: never compare it across
   *  processes, and a receipt that persists freshness drops it rather than
   *  reshaping the record. */
  gatherGeneration?: number
  refreshedAt: number
  projectRoot: string
  generation: WorkbenchGeneration
  root: WorkbenchThreadRow
  /** Child threads (agents, teammates, workflow workers, seats, jobs). */
  threads: WorkbenchThreadRow[]
  lanes: WorkbenchLaneRow[]
  missions: WorkbenchMissionRow[]
  /** Review-artifact heads — empty until artifacts exist. */
  artifactHeads: WorkbenchArtifactHead[]
  /** Open review work — empty until comments exist. */
  reviewQueue: WorkbenchReviewItem[]
  /** ONE best next action — derived from real owner state, or null. */
  nextAction: string | null
  /** The attention view, BY REFERENCE at mint — the ONE
   *  view-model object (services/attention/viewModel). Surfaces needing
   *  liveness subscribe the view directly (the board does); this member
   *  exists so snapshot-shaped consumers (resources, ACP) read the same
   *  truth, never a second projection. */
  attention?: import('../../services/attention/viewModel.js').AttentionViewV1
  /** Per-source read health. REQUIRED on purpose: every snapshot producer must
   *  state what it actually observed, and the compile break is the migration
   *  ratchet. */
  sources: WorkbenchSources
}
