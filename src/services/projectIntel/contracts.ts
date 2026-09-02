// ============================================================================
//  projectIntel/contracts — the project-intelligence vocabulary.
//
//  ONE bounded, generation-keyed snapshot of the current project, COMPOSED
//  from facts other owners already produce (repoSurfaceMap's bounded walk,
//  the gitGraph typed observation, the verify-evidence tree digest, presence
//  facts for instructions/wiki/knowledge). It is an index of stable refs and
//  small summaries — never a second copy of file bodies, transcripts, or
//  memory documents, and never a second walk owner (the surface scan IS
//  repoSurfaceMap's scan, exposed structurally).
//
//  Freshness law: every snapshot carries its generation (working-tree digest
//  + HEAD) and every consumer can see whether a cache read validated against
//  the live digest. A partial fact names itself — 'unavailable' with a note,
//  never a silent empty.
//
//  Gate: MERCURY_PROJECT_INTEL (default-on, additive). `=0` ⇒ no snapshot
//  owner, mercury://project unavailable, zero standing cost — byte-identical.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { RepoSurfaceFacts } from '../../utils/cockpit/repoSurfaceMap.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function projectIntelEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_PROJECT_INTEL'))
}

/** The generation stamp every snapshot (and every child projection) carries. */
export interface SnapshotGeneration {
  /** Content-true working-tree digest (verify-evidence's owner); null when
   *  not a git repo or git is unavailable. */
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  /** Wall-clock build stamp (diagnostic only — never a validity input). */
  scannedAtMs: number
  /** Wall-clock of the last SUCCESSFUL same-tree validation (hot-path
   *  cadence C2, additive): a cache-validated read proves currency, and
   *  discarding that evidence made every maxStaleMs read past the build age
   *  re-pay the tree digest forever. Staleness reads
   *  max(scannedAtMs, validatedAtMs). */
  validatedAtMs?: number
  /** How long the base build took (receipt for the latency gates). */
  buildMs: number
}

export interface GitFacts {
  state: 'ok' | 'unavailable'
  note?: string
  /** Changed paths (tracked + untracked + unmerged), bounded. */
  changed: Array<{ path: string; kind: 'tracked' | 'untracked' | 'unmerged' }>
  changedTruncated: boolean
  ahead: number
  behind: number
}

export interface InstructionFacts {
  claudeMd: boolean
  agentsMd: boolean
  /** Project rules/config homes present (.mercury). */
  configHomes: string[]
}

export interface KnowledgeFacts {
  /** docs/wiki/INDEX.md — the repo's own architecture router. */
  wikiIndex: boolean
}

export interface ProjectIntelSnapshot {
  schema: 1
  workspace: string
  generation: SnapshotGeneration
  /** The bounded structural scan — repoSurfaceMap's facts, one walk owner. */
  surface: RepoSurfaceFacts | null
  git: GitFacts
  instructions: InstructionFacts
  knowledge: KnowledgeFacts
  /** Named caps and omissions — a partial snapshot says so. */
  caps: { surfaceTruncated: boolean; changedCap: number; omissions: string[] }
}

/** Cache read result — consumers see whether validation happened. */
export interface SnapshotRead {
  snapshot: ProjectIntelSnapshot
  /** 'fresh' = built this call · 'cache-validated' = digest matched ·
   *  'cache-ttl' = no digest available, age-bounded reuse (named). */
  from: 'fresh' | 'cache-validated' | 'cache-ttl'
}
