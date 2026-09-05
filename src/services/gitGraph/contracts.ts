
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function gitGraphEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_GIT_GRAPH'))
}

export interface GitFileState {
  path: string
  staged: string
  unstaged: string
  kind: 'tracked' | 'untracked' | 'unmerged'
  origPath?: string
}

export interface GitStatus {
  root: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  head: string
  files: GitFileState[]
  digest: string
  clean: boolean
}

export interface GitHunk {
  id: string
  file: string
  header: string
  lines: string[]
  additions: number
  deletions: number
}

export interface GitDiff {
  scope: 'worktree' | 'staged' | 'commit' | 'range'
  ref?: string
  files: { path: string; additions: number; deletions: number; binary: boolean }[]
  hunks: GitHunk[]
  truncated: boolean
}

export interface GitCommitMeta {
  sha: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
  files: { path: string; status: string }[]
  parents: string[]
}

export interface GitWorktreeInfo {
  path: string
  head: string
  branch: string | null
  isMain: boolean
}

export interface GitConflict {
  id: string
  path: string
  base: string[]
  ours: string[]
  theirs: string[]
}


export interface GitPlanGroup {
  files: string[]
  hunks?: Record<string, string[]>
  message: string
  checks?: string[]
}

export type GitPlanState = 'proposed' | 'applied' | 'stale' | 'cancelled' | 'failed'

export interface GitPlan {
  id: string
  createdAt: number
  state: GitPlanState
  root: string
  digest: string
  head: string
  groups: GitPlanGroup[]
  exclusions: string[]
  provenance?: Record<string, 'mercury' | 'external'>
  ambiguous: string[]
  appliedAt?: number
  commits?: { sha: string; message: string; files: string[]; transactionId: string }[]
  note?: string
}

export interface GitUnavailable {
  failure?: string
  state: 'unavailable'
  note: string
}
