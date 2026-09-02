// ============================================================================
//  gitGraph/contracts — the local Git work-graph vocabulary (
// Typed, bounded observation of local Git state + preview-first
//  transactional commit plans.
//
//  Gate: MERCURY_GIT_GRAPH (default-on, registered). LAWS:
//    · LOCAL only — never push, never fetch, never touch a remote;
//    · never rewrite existing history (no amend/rebase/reset --hard ops);
//    · never discard uncommitted CONTENT (staging state is re-derived
//      during plan application — file content is never lost);
//    · plans are stale-safe: application revalidates the work-tree digest
//      and refuses if the tree changed;
//    · a commit can never include an unplanned file — verified from the
//      created commit itself, not assumed.
//  Ordinary Bash git stays available — this is the structured, inspectable,
//  verifiable path, not a prohibition.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The git work-graph gate (MERCURY_GIT_GRAPH, default-on; re-read live). */
export function gitGraphEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_GIT_GRAPH'))
}

export interface GitFileState {
  path: string
  /** porcelain v2 XY (staged/unstaged) or 'untracked' / 'unmerged'. */
  staged: string
  unstaged: string
  kind: 'tracked' | 'untracked' | 'unmerged'
  /** rename origin, when the entry is a rename. */
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
  /** sha1 over (HEAD · porcelain v2 output) — the stale-refusal truth. */
  digest: string
  clean: boolean
}

export interface GitHunk {
  /** Content-derived stable id: gh-<hash(file · header · body)>. */
  id: string
  file: string
  header: string
  /** Bounded body lines (the unified-diff hunk). */
  lines: string[]
  additions: number
  deletions: number
}

export interface GitDiff {
  scope: 'worktree' | 'staged' | 'commit' | 'range'
  ref?: string
  files: { path: string; additions: number; deletions: number; binary: boolean }[]
  hunks: GitHunk[]
  /** True when bounds truncated hunks (never silent). */
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
  /** gc-<hash(path)> */
  id: string
  path: string
  /** Bounded three-way content heads (base · ours · theirs). */
  base: string[]
  ours: string[]
  theirs: string[]
}

// ── commit plans ─────────────────────────────────────────────────────────────

export interface GitPlanGroup {
  /** Exact files (repo-relative). A file appears in at most ONE group. */
  files: string[]
  /** Optional exact hunk subset per file (partial-hunk staging). */
  hunks?: Record<string, string[]>
  message: string
  /** Checks the operator associates with this group (recorded, not run). */
  checks?: string[]
}

export type GitPlanState = 'proposed' | 'applied' | 'stale' | 'cancelled' | 'failed'

export interface GitPlan {
  /** gp-<hash> — content-derived. */
  id: string
  createdAt: number
  state: GitPlanState
  root: string
  /** The stale-refusal truth captured at prepare time. */
  digest: string
  head: string
  groups: GitPlanGroup[]
  /** Changed files deliberately NOT in any group (exclusions, named). */
  exclusions: string[]
  /**  provenance-before-staging: which changed paths Mercury
   *  itself edited this session vs external edits (operator, linter,
   *  another tool) — the plan surface names them so external work is never
   *  swept into a commit unnoticed. Absent when the caller had no
   *  file-history state to derive from. */
  provenance?: Record<string, 'mercury' | 'external'>
  /** Files with BOTH staged and unstaged edits at prepare time — staging
   *  state is re-derived during application (content never lost). */
  ambiguous: string[]
  /** Set when applied. */
  appliedAt?: number
  commits?: { sha: string; message: string; files: string[]; transactionId: string }[]
  note?: string
}

export interface GitUnavailable {
  state: 'unavailable'
  note: string
}
