
export const CORPUS_SCHEMA_VERSION = 1

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
  17: 'multi-file-change-set',
  18: 'topdown-action-game',
  19: 'cli-update-journey',
  20: 'cross-module-change',
  21: 'contradictory-constraints',
  22: 'long-session-continuity',
  23: 'multi-agent-integration',
  24: 'responsive-web-product',
} as const
export type HelixFamilyId = keyof typeof HELIX_FAMILIES

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

export type FileMap = Record<string, string>
export type BranchOverlay = Record<string, string | null>

export interface HelixRepoSpec {
  id: HelixRepoId
  seed: 'apex-fixture' | 'inline'
  files?: FileMap
  branches?: Record<string, BranchOverlay>
}

export interface HelixCheck {
  cmd: string[]
  expectExit: number
  timeoutSec?: number
}

export interface HelixGraderSpec {
  checks: HelixCheck[]
  mustChange?: string[]
  onlyChange?: string[]
  mustNotChange?: string[]
  zeroDiff?: boolean
  requiredTokens?: string[]
  forbiddenPatterns?: string[]
}

export interface HelixSolutionVariant {
  name: string
  files?: FileMap
  answer?: string
}

export interface HelixTask {
  id: string
  family: HelixFamilyId
  title: string
  repo: HelixRepoId
  ref: { kind: 'branch'; value: string } | { kind: 'sha'; value: string }
  partition: HelixPartition
  brief: string
  timeCeilingSec: number
  humanEstimate?: { minutes: number; method: string }
  sourceClass: 'reconstructed-defect' | 'engineering-work' | 'investigation' | 'collaboration'
  variability: 'exact' | 'behavioral'
  grader: HelixGraderSpec
  reference: HelixSolutionVariant
  falsify: HelixSolutionVariant[]
  runner?: {
    switchPair?: 'first' | 'second'
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
  changedPaths: string[]
  gradedAtMs: number
}

export const APEX_FIXTURE_SHA = '828cb05129252ff4383cbc14a5243177790378dc'

export const CORPUS_SEED_ROOT = '/tmp/helix-corpus'
