
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectConfigDirs } from '../../utils/projectConfig.js'
import { projectOwner, OwnerScopedStore } from '../primitives/owner.js'
import { gitStatus, gitStatusAsync } from '../gitGraph/observe.js'
import type { GitStatus, GitUnavailable } from '../gitGraph/contracts.js'
import {
  computeWorkingTreeDigest,
  computeWorkingTreeDigestAsync,
} from '../../utils/verification/verificationState.js'
import { scanRepoSurface } from '../../utils/cockpit/repoSurfaceMap.js'
import {
  projectIntelEnabled,
  type GitFacts,
  type InstructionFacts,
  type KnowledgeFacts,
  type ProjectIntelSnapshot,
  type SnapshotRead,
} from './contracts.js'

const CHANGED_CAP = 200
const NO_DIGEST_TTL_MS = 30_000

interface SnapshotHolder {
  snapshot: ProjectIntelSnapshot | null
}

const cache = new OwnerScopedStore<SnapshotHolder>({
  name: 'project-intel',
  create: () => ({ snapshot: null }),
  cap: 8,
})

function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

type GitFactsRead = { facts: GitFacts; headSha: string | null; branch: string | null }

function gitFacts(workspace: string): GitFactsRead {
  return gitFactsFrom(gitStatus(workspace))
}

async function gitFactsAsync(workspace: string): Promise<GitFactsRead> {
  return gitFactsFrom(await gitStatusAsync(workspace))
}

function gitFactsFrom(status: GitStatus | GitUnavailable): GitFactsRead {
  if ('state' in status) {
    return {
      facts: { state: 'unavailable', note: status.note, changed: [], changedTruncated: false, ahead: 0, behind: 0 },
      headSha: null,
      branch: null,
    }
  }
  const changed = status.files.slice(0, CHANGED_CAP).map(f => ({ path: f.path, kind: f.kind }))
  return {
    facts: {
      state: 'ok',
      changed,
      changedTruncated: status.files.length > CHANGED_CAP,
      ahead: status.ahead,
      behind: status.behind,
    },
    headSha: status.head === '(unborn)' ? null : status.head,
    branch: status.branch,
  }
}

function instructionFacts(workspace: string): InstructionFacts {
  const configHomes = projectConfigDirs(workspace)
    .filter(dir => exists(dir))
    .map(dir => basename(dir))
  return {
    mercuryMd: exists(join(workspace, 'MERCURY.md')),
    agentsMd: exists(join(workspace, 'AGENTS.md')),
    otherHarnessInstructions: ['CLAUDE.md'].filter(name => exists(join(workspace, name))),
    configHomes,
  }
}

function knowledgeFacts(workspace: string): KnowledgeFacts {
  return {
    wikiIndex: exists(join(workspace, 'docs', 'wiki', 'INDEX.md')),
  }
}

function buildSnapshot(workspace: string): ProjectIntelSnapshot {
  const t0 = performance.now()
  const treeDigest = computeWorkingTreeDigest(workspace)
  return buildSnapshotWithDigest(workspace, treeDigest, t0)
}

function buildSnapshotWithDigest(
  workspace: string,
  treeDigest: string | null,
  t0: number,
): ProjectIntelSnapshot {
  return composeSnapshot(workspace, treeDigest, t0, scanRepoSurface(workspace), gitFacts(workspace))
}

async function buildSnapshotWithDigestAsync(
  workspace: string,
  treeDigest: string | null,
  t0: number,
): Promise<ProjectIntelSnapshot> {
  const git = await gitFactsAsync(workspace)
  return composeSnapshot(workspace, treeDigest, t0, scanRepoSurface(workspace), git)
}

function composeSnapshot(
  workspace: string,
  treeDigest: string | null,
  t0: number,
  surface: ReturnType<typeof scanRepoSurface>,
  git: GitFactsRead,
): ProjectIntelSnapshot {
  const omissions: string[] = []
  if (surface?.truncated) omissions.push(`surface scan capped (large tree — map partial)`)
  if (git.facts.changedTruncated) omissions.push(`changed paths capped at ${CHANGED_CAP}`)
  if (treeDigest === null) omissions.push('no tree digest (not a git repo or git unavailable)')
  return {
    schema: 1,
    workspace,
    generation: {
      treeDigest,
      headSha: git.headSha,
      branch: git.branch,
      scannedAtMs: Date.now(),
      buildMs: Math.round(performance.now() - t0),
    },
    surface,
    git: git.facts,
    instructions: instructionFacts(workspace),
    knowledge: knowledgeFacts(workspace),
    caps: {
      surfaceTruncated: surface?.truncated ?? false,
      changedCap: CHANGED_CAP,
      omissions,
    },
  }
}

export function getProjectSnapshot(
  workspace: string,
  opts: { maxStaleMs?: number } = {},
): SnapshotRead | null {
  if (!projectIntelEnabled()) return null
  const holder = cache.get(projectOwner(workspace))
  if (holder.snapshot) {
    const gen = holder.snapshot.generation
    const currentAsOf = Math.max(gen.scannedAtMs, gen.validatedAtMs ?? 0)
    if (
      opts.maxStaleMs !== undefined &&
      Date.now() - currentAsOf < Math.max(0, opts.maxStaleMs)
    ) {
      return { snapshot: holder.snapshot, from: 'cache-ttl' }
    }
    if (gen.treeDigest !== null) {
      const current = computeWorkingTreeDigest(workspace)
      if (current !== null && current === gen.treeDigest) {
        gen.validatedAtMs = Date.now()
        return { snapshot: holder.snapshot, from: 'cache-validated' }
      }
    } else if (Date.now() - currentAsOf < NO_DIGEST_TTL_MS) {
      return { snapshot: holder.snapshot, from: 'cache-ttl' }
    }
  }
  const snapshot = buildSnapshot(workspace)
  holder.snapshot = snapshot
  return { snapshot, from: 'fresh' }
}

const buildInFlight = new Map<string, Promise<SnapshotRead>>()

export async function getProjectSnapshotAsync(
  workspace: string,
  opts: { maxStaleMs?: number } = {},
): Promise<SnapshotRead | null> {
  if (!projectIntelEnabled()) return null
  const holder = cache.get(projectOwner(workspace))
  if (holder.snapshot) {
    const gen = holder.snapshot.generation
    const currentAsOf = Math.max(gen.scannedAtMs, gen.validatedAtMs ?? 0)
    if (
      opts.maxStaleMs !== undefined &&
      Date.now() - currentAsOf < Math.max(0, opts.maxStaleMs)
    ) {
      return { snapshot: holder.snapshot, from: 'cache-ttl' }
    }
    if (gen.treeDigest !== null) {
      const current = await computeWorkingTreeDigestAsync(workspace)
      if (current !== null && current === gen.treeDigest) {
        gen.validatedAtMs = Date.now()
        return { snapshot: holder.snapshot, from: 'cache-validated' }
      }
    } else if (Date.now() - currentAsOf < NO_DIGEST_TTL_MS) {
      return { snapshot: holder.snapshot, from: 'cache-ttl' }
    }
  }
  const inFlight = buildInFlight.get(workspace)
  if (inFlight) return inFlight
  const build = (async (): Promise<SnapshotRead> => {
    try {
      const t0 = performance.now()
      const treeDigest = await computeWorkingTreeDigestAsync(workspace)
      const snapshot = await buildSnapshotWithDigestAsync(workspace, treeDigest, t0)
      holder.snapshot = snapshot
      return { snapshot, from: 'fresh' as const }
    } finally {
      buildInFlight.delete(workspace)
    }
  })()
  buildInFlight.set(workspace, build)
  return build
}

export function _resetProjectIntelForTesting(): void {
  cache.clearAllForShutdown()
  buildInFlight.clear()
}
