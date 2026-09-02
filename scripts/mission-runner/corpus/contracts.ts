// ============================================================================
//  scripts/mission-runner/corpus/contracts.ts — the corpus schema (v1).
//
//  ONE source of truth: task definitions (tasks.ts) carry the brief, the
//  grader spec, the reference solution AND the falsify variants, so the
//  seeder, the grader engine, the manifest and the falsifiability prover can
//  never drift apart. The agent under evaluation receives
//  ONLY: the brief + the seeded repository state (+ normal project context).
//  Grader code, reference content and falsify variants are harness-side.
//
//  Corpus laws encoded here:
//    - every task fails before repair OR carries an explicit no-change oracle
//      (zeroDiff + token oracle);
//    - graders detect plausible wrong solutions (falsify variants are part of
//      the task definition and proved rejected);
//    - deterministic setup/teardown (fixed git identity/dates ⇒ pinned SHAs);
//    - no ambient operator files; no live external service in any verdict;
//    - model calls only in the live runner, never in the repository gate.
// ============================================================================

export const CORPUS_SCHEMA_VERSION = 1

/** Machine prerequisites for the authoritative verdict (recorded, checked). */
export const CORPUS_PREREQUISITES = ['git', 'node>=22', 'python3>=3.9'] as const

export const HELIX_FAMILIES = {
  1: 'orientation-discovery',
  2: 'narrow-bug-repair',
  3: 'multi-file-typed-refactor',
  4: 'rename-with-decoy',
  5: 'runtime-diagnosis',
  6: 'misleading-symptom',
  7: 'long-tool-heavy',
  8: 'solo-suitable',
  9: 'disjoint-lanes',
  10: 'hidden-shared-owner',
  11: 'cheaper-model-sufficient',
  12: 'strongest-planner',
  13: 'provider-switch',
  14: 'replan-trap',
  15: 'no-change-investigation',
  16: 'collaboration',
  // coordinated multi-file text-edit work (the ChangeSet vs
  // sequential-FileEdit measurement family; partition 'comparison').
  17: 'multi-file-change-set',
  // the difficult-work families — multi-hour, visually
  // and mechanically rich missions. New ids join the enumeration; nothing
  // above is ever renumbered.
  18: 'topdown-action-game',
  19: 'cli-update-journey',
  20: 'cross-module-change',
  21: 'contradictory-constraints',
  22: 'long-session-continuity',
  23: 'multi-agent-integration',
  24: 'responsive-web-product',
} as const
export type HelixFamilyId = keyof typeof HELIX_FAMILIES

/** 'comparison' = the same-model comparison-lab partition — a declared
 *  extension point; the frozen
 *  'qualification' partition is never edited or tuned against.
 *  'crucible-dev' = the difficult-work development partition;
 *  'crucible-calibration'/'crucible-qualification' are sealed:
 *  qualification holds the frozen eight, calibration
 *  the paired-check anchor (EW2), dev the still-trivial-flagged canary
 *  (GM3). Qualification tasks' graders and briefs are
 *  IMMUTABLE (the seal law;
 *  a declared partition may never sit empty — the schema prover). */
export const HELIX_PARTITIONS = [
  'development',
  'calibration',
  'qualification',
  'comparison',
  'crucible-dev',
  'crucible-calibration',
  'crucible-qualification',
] as const
export type HelixPartition = (typeof HELIX_PARTITIONS)[number]

export type HelixRepoId =
  | 'stats'
  | 'notedeck'
  | 'pyledger'
  | 'relay'
  | 'textkit'
  | 'gridgame'
  | 'emberweald'
  | 'lanternkit'
  | 'greymarsh'
  | 'waypost'

/** File map: path → full content. A branch overlay may delete with null. */
export type FileMap = Record<string, string>
export type BranchOverlay = Record<string, string | null>

export interface HelixRepoSpec {
  id: HelixRepoId
  /** 'apex-fixture' delegates to scripts/model-routing/live/seed-bench-fixture.sh
   * */
  seed: 'apex-fixture' | 'inline'
  /** Base tree (inline repos). */
  files?: FileMap
  /** Task-state branches: name → overlay applied on base, committed with the
   *  fixed identity/date ⇒ deterministic per-branch SHAs. */
  branches?: Record<string, BranchOverlay>
}

export interface HelixCheck {
  /** argv, run in the task work dir. */
  cmd: string[]
  expectExit: number
  /** Optional deadline for the check itself (default 120s). */
  timeoutSec?: number
}

export interface HelixGraderSpec {
  checks: HelixCheck[]
  /** Every listed path must appear in the observed change set. */
  mustChange?: string[]
  /** The observed change set must be a NON-EMPTY subset of these paths
   *  (created files included). Mutually exclusive with zeroDiff. */
  onlyChange?: string[]
  /** Paths that must NOT appear in the observed change set. */
  mustNotChange?: string[]
  /** No-change oracle: the repository must be byte-identical to the task ref. */
  zeroDiff?: boolean
  /** Result-text oracle (case-insensitive substring match, ALL required). */
  requiredTokens?: string[]
  /** Result-text regexes (case-insensitive) that must NOT match. */
  forbiddenPatterns?: string[]
}

export interface HelixSolutionVariant {
  name: string
  /** Files to write over the task state (harness-side; never shown to agents). */
  files?: FileMap
  /** Simulated final result text (for token-oracle tasks). */
  answer?: string
}

export interface HelixTask {
  id: string
  family: HelixFamilyId
  title: string
  repo: HelixRepoId
  /** Branch name on the seeded repo, or the pinned SHA for 'apex-fixture'. */
  ref: { kind: 'branch'; value: string } | { kind: 'sha'; value: string }
  partition: HelixPartition
  /** The complete agent-visible mission statement. */
  brief: string
  timeCeilingSec: number
  /** skilled-human time estimate + the estimation method
   *  (recorded per difficult-work task; METR-style horizon banding). */
  humanEstimate?: { minutes: number; method: string }
  sourceClass: 'reconstructed-defect' | 'engineering-work' | 'investigation' | 'collaboration'
  /** Permitted solution variability: 'behavioral' = any change passing the
   *  grader; 'exact' = effectively one correct content (mechanical tasks). */
  variability: 'exact' | 'behavioral'
  grader: HelixGraderSpec
  /** Known-good solution — proves the grader IS satisfiable (harness-side). */
  reference: HelixSolutionVariant
  /** Plausible wrong solutions — proved REJECTED by the grader. */
  falsify: HelixSolutionVariant[]
  runner?: {
    /** Family-13 pairing: run consecutively with a provider switch between. */
    switchPair?: 'first' | 'second'
    /** Family-16: requires the accepted harness; else NOT APPLICABLE. */
    collaboration?: boolean
  }
}

export interface HelixGradeComponent {
  name: 'checks' | 'diff-scope' | 'result-text'
  pass: boolean
  detail: string
}

export interface HelixGradeVerdict {
  taskId: string
  accepted: boolean
  components: HelixGradeComponent[]
  /** Observed change set (tracked diffs + untracked files) vs the task ref. */
  changedPaths: string[]
  gradedAtMs: number
}

/** The fixture pin (scripts/model-routing/live/seed-bench-fixture.sh). */
export const APEX_FIXTURE_SHA = '828cb05129252ff4383cbc14a5243177790378dc'

/** Where seeded corpus repos live (outside the Mercury tree, disposable). */
export const CORPUS_SEED_ROOT = '/tmp/helix-corpus'
