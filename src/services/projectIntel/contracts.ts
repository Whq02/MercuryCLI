
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { RepoSurfaceFacts } from '../../utils/cockpit/repoSurfaceMap.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function projectIntelEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_PROJECT_INTEL'))
}

export interface SnapshotGeneration {
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  scannedAtMs: number
  validatedAtMs?: number
  buildMs: number
}

export interface GitFacts {
  state: 'ok' | 'unavailable'
  note?: string
  changed: Array<{ path: string; kind: 'tracked' | 'untracked' | 'unmerged' }>
  changedTruncated: boolean
  ahead: number
  behind: number
}

export interface InstructionFacts {
  mercuryMd: boolean
  agentsMd: boolean
  otherHarnessInstructions: string[]
  configHomes: string[]
}

export interface KnowledgeFacts {
  wikiIndex: boolean
}

export interface ProjectIntelSnapshot {
  schema: 1
  workspace: string
  generation: SnapshotGeneration
  surface: RepoSurfaceFacts | null
  git: GitFacts
  instructions: InstructionFacts
  knowledge: KnowledgeFacts
  caps: { surfaceTruncated: boolean; changedCap: number; omissions: string[] }
}

export interface SnapshotRead {
  snapshot: ProjectIntelSnapshot
  from: 'fresh' | 'cache-validated' | 'cache-ttl'
}
