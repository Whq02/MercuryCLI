
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SourceHealth } from '../../substrate/sourceState.js'

export const WORKBENCH_SOURCES_SCHEMA = 1 as const

export interface WorkbenchSources {
  schema: typeof WORKBENCH_SOURCES_SCHEMA
  artifacts: SourceHealth
  contextLanes: SourceHealth
  gitWorktrees: SourceHealth
}

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
  id: string
  kind: WorkbenchThreadKind
  title: string
  parentId?: string
  model?: string
  effortOverride?: string
  phase: string
  state: string
  laneId?: string
  agentId?: string
  worktreePath?: string
  startedAt?: number
  updatedAt: number
  changedPaths: string[]
  totalChangedPaths?: number
  verification?: string
  blocker?: string
  latestResultRef?: string
  refs: string[]
}

export type WorkbenchLaneSource =
  | 'context-lane'
  | 'agent-worktree'
  | 'worktree'

export interface WorkbenchLaneRow {
  laneId: string
  displayName: string
  source: WorkbenchLaneSource
  status: string
  worktreePath?: string
  goal?: string
  ownerThreadId?: string
  branch?: string
  baseSha?: string
  headSha?: string
  dirty?: boolean
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
  stale?: boolean
}

export interface WorkbenchReviewItem {
  ref: string
  note: string
}

export interface WorkbenchSnapshot {
  version: number
  gatherGeneration?: number
  refreshedAt: number
  projectRoot: string
  generation: WorkbenchGeneration
  root: WorkbenchThreadRow
  threads: WorkbenchThreadRow[]
  lanes: WorkbenchLaneRow[]
  missions: WorkbenchMissionRow[]
  artifactHeads: WorkbenchArtifactHead[]
  reviewQueue: WorkbenchReviewItem[]
  nextAction: string | null
  attention?: import('../../services/attention/viewModel.js').AttentionViewV1
  sources: WorkbenchSources
}
