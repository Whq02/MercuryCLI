// ============================================================================
//  projectIntel/snapshot — the generation-keyed project snapshot owner.
//
//  Composition, not duplication:
//    · structural topology  → repoSurfaceMap.scanRepoSurface (the ONE walk)
//    · git truth            → gitGraph observe.gitStatus (typed, live)
//    · generation key       → verificationState.computeWorkingTreeDigest
//                             (the SAME digest evidence binds to; 10s TTL
//                              inside doubles as burst coalescing)
//    · presence facts       → bounded statSync (names only)
//
// Cache law: keyed by workspace; a cache read VALIDATES the live
//  tree digest before calling itself current. Digest-less workspaces (not a
//  git repo) fall back to a short TTL and the read names that ('cache-ttl').
//  Bursts coalesce through the digest cache's own TTL. Interactive-path law
// the tree digest is ~1.5s of git subprocess wall time on a
//  large repo, so the DRAIN path (the capsule producer) must use
//  getProjectSnapshotAsync — the sync read is for user-invoked surfaces
//  (/orient, Inspect) only. Expensive facts (launch discovery, symbol
//  lookups) are ON-DEMAND children resolved by the adapter, stamped with
//  this generation — never eagerly built.
// ============================================================================

import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectConfigDirs } from '../../utils/projectConfig.js'
import { projectOwner, OwnerScopedStore } from '../primitives/owner.js'
import { gitStatus } from '../gitGraph/observe.js'
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
/** Digest-less fallback reuse window (named in the read as 'cache-ttl'). */
const NO_DIGEST_TTL_MS = 30_000

/** Mutable per-project holder — the store owns retention + disposal. */
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

function gitFacts(workspace: string): { facts: GitFacts; headSha: string | null; branch: string | null } {
  const status = gitStatus(workspace)
  // GitUnavailable is the only member carrying a 'state' discriminant.
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
  // The project-config home rides the ONE seam (projectConfig.ts) — never
  // fresh literals (the task-#26 law).
  const configHomes = projectConfigDirs(workspace)
    .filter(dir => exists(dir))
    .map(dir => basename(dir))
  return {
    claudeMd: exists(join(workspace, 'CLAUDE.md')),
    agentsMd: exists(join(workspace, 'AGENTS.md')),
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

/** The digest-independent remainder of a build: bounded sync fs work (scan
 *  ≈33ms, git status ≈107ms on this repo — NAMED; the ~1.5s tree digest is
 *  the caller's concern, sync or async). */
function buildSnapshotWithDigest(
  workspace: string,
  treeDigest: string | null,
  t0: number,
): ProjectIntelSnapshot {
  const surface = scanRepoSurface(workspace)
  const git = gitFacts(workspace)
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

/**
 * Get the project snapshot for a workspace. Cache validates the live tree
 * digest before reuse; digest-less workspaces reuse within a short TTL and
 * the read SAYS so. Throws never; disabled gate answers null.
 *
 * `maxStaleMs` is the HOT-PATH escape hatch (the per-turn attachment
 * producer): a cached snapshot younger than the bound is returned WITHOUT
 * any digest work — computeWorkingTreeDigest spawns three git subprocesses
 * and the post-mutation cache is always cold (markMutation clears it), so
 * an unbounded validate on the drain path would block the event loop ~0.5-
 * 1.4s per editing round on a large repo (the estate's never-spawn-git-on-
 * hot-paths law, verificationState's own skipDigest precedent). The read is
 * NAMED 'cache-ttl' so consumers see it skipped validation.
 */
export function getProjectSnapshot(
  workspace: string,
  opts: { maxStaleMs?: number } = {},
): SnapshotRead | null {
  if (!projectIntelEnabled()) return null
  const holder = cache.get(projectOwner(workspace))
  if (holder.snapshot) {
    const gen = holder.snapshot.generation
    // Currency = the newest PROOF of the tree (build OR successful
    // validation — hot-path cadence C2): validation succeeding is evidence
    // of currency, and discarding it made every read past the build age
    // re-pay the digest forever.
    const currentAsOf = Math.max(gen.scannedAtMs, gen.validatedAtMs ?? 0)
    if (
      opts.maxStaleMs !== undefined &&
      Date.now() - currentAsOf < Math.max(0, opts.maxStaleMs)
    ) {
      return { snapshot: holder.snapshot, from: 'cache-ttl' }
    }
    if (gen.treeDigest !== null) {
      // computeWorkingTreeDigest's own 10s TTL makes this cheap under bursts.
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

/**
 * Async read for DRAIN/HOT paths (the per-turn capsule producer): identical
 * cache/validation flow, but every tree-digest computation — the cold build's
 * ~1.5s bulk AND the post-TTL revalidate — rides the async digest, so the
 * event loop stays live (the sync form burst-drained queued keypresses out of
 * their state windows: the tasks-runs-only red). The residual
 * sync work (scan + git status, ≈140ms on this repo) is bounded and NAMED in
 * buildSnapshotWithDigest. Cold builds coalesce per workspace.
 */
const buildInFlight = new Map<string, Promise<SnapshotRead>>()

export async function getProjectSnapshotAsync(
  workspace: string,
  opts: { maxStaleMs?: number } = {},
): Promise<SnapshotRead | null> {
  if (!projectIntelEnabled()) return null
  const holder = cache.get(projectOwner(workspace))
  if (holder.snapshot) {
    const gen = holder.snapshot.generation
    // Same currency law as the sync reader (hot-path cadence C2).
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
      const snapshot = buildSnapshotWithDigest(workspace, treeDigest, t0)
      holder.snapshot = snapshot
      return { snapshot, from: 'fresh' as const }
    } finally {
      buildInFlight.delete(workspace)
    }
  })()
  buildInFlight.set(workspace, build)
  return build
}

/** TEST-ONLY: reset the module cache (proof harnesses). */
export function _resetProjectIntelForTesting(): void {
  cache.clearAllForShutdown()
  buildInFlight.clear()
}
