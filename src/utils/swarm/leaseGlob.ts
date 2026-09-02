/**
 * File-lease coordination — an atomic, file-backed path-glob lease store
 * scoped to a single team.
 *
 * An agent CLAIMS a set of path globs; two agents must never hold overlapping
 * globs. The store is the source of truth for "who owns what" so a PreToolUse
 * guard (see leaseGuard.ts) can DENY an Edit/Write that lands on another
 * agent's leased path.
 *
 * Design (the lease / glob / expiry trio, on Mercury's conventions):
 *
 *   - Storage: a single lock-guarded `leases.json` under the team's config dir
 *     (`<config home>/teams/<team>/leases/leases.json`). One file (not one per
 *     agent) so a claim can atomically check ALL other agents' globs for
 *     overlap under a single lock — the invariant ("no two agents hold
 *     overlapping globs") can't be enforced across N independently-written
 *     files without a global lock anyway.
 *
 *   - Atomicity: all mutations take an exclusive lock (lockfile.ts / O_EXCL via
 *     proper-lockfile) around read-modify-write. Readers (listLeases,
 *     getLeaseConflict) take NO lock — they must never block a tool call — so
 *     writes publish via tmp+rename (atomic on POSIX); a reader never sees a
 *     torn/partial JSON that could FALSE-DENY a legitimate edit.
 *
 *   - Overlap (coord-glob's `overlap`): BROAD, leading-literal-prefix coverage.
 *     A wildcard claim conservatively locks its whole subtree so conflict
 *     detection never MISSES a clash. `src/**` and `src/foo.ts` overlap;
 *     `src/a/**` and `src/b/**` do not.
 *
 *   - Match (coord-glob's `matchFile`): PRECISE, per-segment. Used by the guard
 *     to decide whether a concrete file path falls under a lease's globs, so a
 *     wildcard lease grants/guards exactly what it names (least privilege).
 *
 *   - Namespace: globs are normalized to repo-relative-against-base POSIX form
 *     (relScope) so the claim store, the conflict check, and the guard share
 *     ONE namespace — `claim /abs/x` and `claim x` can't split-brain into two
 *     owners of one file. A glob that escapes `base` (`..`-prefixed) is rejected
 *     rather than stored as an out-of-repo lease.
 *
 *   - TTL/expiry (lease-expiry's `isExpired`): a stale lease (from a crashed or
 *     killed agent) is treated as not-active at READ time once past its TTL, so
 *     it stops granting/conflicting without a writer. `sweepExpiredLeases`
 *     additionally prunes them from disk. Back-compat: a lease with no ttl/
 *     expiry NEVER expires (indefinite — legacy semantics).
 *
 *   - EMPTY STORE ⇒ no leases ⇒ everything allowed (the default-safe invariant
 *     ITEM 5 depends on).
 */

import { join, relative, resolve } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { defineStore } from '../../substrate/fileStore.js'
import { getTeamDir, sanitizeName } from './teamHelpers.js'

/** Default lease TTL: stale leases from dead agents expire after this. */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000 // 30 minutes

/** A single agent's lease over a set of path globs. */
export type Lease = {
  /** Owning agent id (stable per-session id or agent type — see leaseGuard). */
  agentId: string
  /** Normalized, repo-relative POSIX path globs this agent holds. */
  globs: string[]
  /** ISO timestamp the lease was (re)claimed at. */
  ts: string
  /** TTL in ms; lease is stale once ts + ttlMs has passed. Omitted ⇒ never expires. */
  ttlMs?: number
}

/** Conflict descriptor: the other agent's id and the specific glob that clashes. */
export type LeaseConflict = {
  agentId: string
  glob: string
}

/** Result of claimLease — success, or the first conflicting {agentId, glob}. */
export type ClaimLeaseResult =
  | { ok: true; lease: Lease }
  | { ok: false; conflict: LeaseConflict }

//
// Glob namespace + overlap/match (single source of truth — mirrors coord-glob)
//

/**
 * Collapse a path/glob to clean repo-relative POSIX form against `base`.
 * Absolute, `./`, and `..` forms all normalize, so the store, the conflict
 * check, and the guard share ONE namespace. A path outside `base` stays
 * `..`-prefixed — callers reject those.
 */
export function relScope(p: string, base: string): string {
  return relative(base, resolve(base, String(p))).replace(/\\/g, '/')
}

/** Reduce a pattern to its longest leading wildcard-free path prefix. */
function literalPrefix(p: string): string {
  const lit: string[] = []
  for (const seg of String(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')) {
    if (seg.includes('*') || seg.includes('?')) break
    lit.push(seg)
  }
  return lit.join('/').replace(/\/+$/, '')
}

/** Broad, segment-aware prefix coverage (errs toward MORE coverage). */
function covers(pattern: string, target: string): boolean {
  const p = literalPrefix(pattern)
  const t = literalPrefix(target)
  if (p === '' || p === '.') return true // whole-repo
  return t === p || t.startsWith(p + '/')
}

/**
 * Two patterns OVERLAP if either's literal prefix covers the other.
 * Used for CONFLICT detection (claim): a wildcard claim conservatively locks
 * its whole subtree so a clash is never missed.
 */
export function globsOverlap(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a)
}

/**
 * Build an anchored regex source for a glob. `**` matches ZERO OR MORE path
 * segments — so `a/**\/b` matches `a/b` too, and a leading `**\/b` matches a
 * top-level `b`; `*`/`?` stay single-segment. Sentinels (NUL-wrapped, never in a
 * real path) carry the wildcard intent through the literal-escape pass so escaping
 * can't corrupt them. Linear / no catastrophic backtracking.
 */
function globToRegExpSource(p: string): string {
  const GS_SLASH = '\x00GS\x00' // a leading/internal `**\/` → zero+ dirs
  const GS = '\x00G\x00' //        a bare `**` (no following slash) → anything
  const STAR = '\x00S\x00'
  const Q = '\x00Q\x00'
  let s = p
    // A leading or internal `**\/` becomes "zero or more <dir>/". The slash is
    // PART of the group, so the zero-segment case leaves no stray separator
    // (`a/**\/b` → `a/(?:[^/]+/)*b`, which matches `a/b`).
    .replace(/(^|\/)\*\*\//g, (_m, lead: string) => (lead ? '/' : '') + GS_SLASH)
    .replace(/\*\*/g, GS) // any remaining `**` (bare / non-segment) → anything
    .replace(/\*/g, STAR)
    .replace(/\?/g, Q)
  s = s.replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape literal regex specials
  s = s
    .split(GS_SLASH)
    .join('(?:[^/]+/)*')
    .split(GS)
    .join('.*')
    .split(STAR)
    .join('[^/]*')
    .split(Q)
    .join('[^/]')
  return '^' + s + '$'
}

/**
 * Precise file match for the guard's GUARD/GRANT decision. Trailing `/*` or
 * `/**` = the whole subtree; a literal path = itself or its subtree; a
 * mid-pattern wildcard is matched per segment (`*` = one segment, `**` = ZERO OR
 * MORE segments). A `..`-escaping pattern can NEVER match (defense-in-depth).
 *
 * NOTE: `**` matching zero segments is load-bearing — the CLAIM-time overlap
 * check (globsOverlap/covers) conservatively locks a `**` pattern's whole
 * subtree, so the guard MUST match every file in that subtree (incl. the
 * zero-extra-segment case, e.g. `src/**\/api.ts` vs `src/api.ts`) or it would
 * FALSE-ALLOW a cross-agent edit the claim believed it had locked.
 */
export function globMatchesFile(pattern: string, file: string): boolean {
  const f = String(file).replace(/\\/g, '/').replace(/\/+$/, '')
  const p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === '..' || p.startsWith('../')) return false
  if (p === '' || p === '.') return true
  const sub = p.replace(/\/\*\*?$/, '') // trailing /* or /** → whole subtree
  if (sub !== p) return f === sub || f.startsWith(sub + '/')
  if (!/[*?]/.test(p)) return f === p || f.startsWith(p + '/') // literal path/dir
  // Compile via globToRegExpSource (zero-segment `**` aware). Guarded in
  // try/catch: a guard match must NEVER throw out of getLeaseConflict (a throw
  // there fails OPEN per leaseGuard). On any compile/exec error, fall back to the
  // safe, broad literal-prefix coverage so a wildcard lease still GUARDS its
  // subtree rather than silently allowing.
  try {
    return new RegExp(globToRegExpSource(p)).test(f)
  } catch {
    return covers(p, f)
  }
}

//
// TTL / expiry (mirrors lease-expiry.isExpired)
//

/**
 * True iff the lease has a TTL and `nowMs` is at or past it. A lease with no
 * ttlMs never expires (legacy/indefinite). A non-parseable ts fails OPEN
 * (not expired) — we never drop a lease we can't reason about.
 */
export function isLeaseExpired(lease: Lease, nowMs: number): boolean {
  if (!lease || typeof lease !== 'object') return false
  if (typeof lease.ttlMs === 'number' && lease.ttlMs > 0 && lease.ts) {
    const start = Date.parse(lease.ts)
    return Number.isFinite(start) ? start + lease.ttlMs <= nowMs : false
  }
  return false
}

//
// Storage
//

type LeaseStore = { leases: Lease[] }

function getLeasesDir(team: string): string {
  return join(getTeamDir(team), 'leases')
}

/** Path to the team's single lease store file. */
export function getLeaseStorePath(team: string): string {
  return join(getLeasesDir(team), 'leases.json')
}

/**
 * The lease store on the substrate kernel. This file was the kernel's DONOR
 * pattern (lock + tmp+rename + lock-free validated reads), so the port is
 * mechanical: the same invariants, now declared once in fileStore.ts.
 * onReadFailure 'empty' IS the fail-OPEN doctrine (an unreadable store
 * must degrade to "no leases ⇒ everything allowed", loudly) — the kernel warns
 * on that path.
 */
const leaseStoreFor = defineStore<LeaseStore, [string]>({
  name: 'leaseGlob',
  path: team => getLeaseStorePath(team),
  schemaVersion: 1,
  decode: raw => {
    const parsed = raw as Partial<LeaseStore> | null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.leases)) {
      return null
    }
    // Drop anything malformed defensively.
    return {
      leases: parsed.leases.filter(
        (l): l is Lease =>
          !!l &&
          typeof l.agentId === 'string' &&
          Array.isArray(l.globs) &&
          typeof l.ts === 'string',
      ),
    }
  },
  empty: () => ({ leases: [] }),
  onReadFailure: 'empty',
})

/** Run `fn` under an exclusive lock on the store (read-modify-write critical section). */
async function withLockedStore<T>(
  team: string,
  fn: (store: LeaseStore) => Promise<{ store: LeaseStore; result: T }> | { store: LeaseStore; result: T },
): Promise<T> {
  return leaseStoreFor(team).update(async store => {
    const { store: next, result } = await fn(store)
    return { next, result }
  })
}

/**
 * Drop expired leases from a store snapshot (pure helper). Returns the SAME
 * reference when nothing is expired — the kernel then skips the no-op publish.
 */
function pruneExpired(store: LeaseStore, nowMs: number): LeaseStore {
  const leases = store.leases.filter(l => !isLeaseExpired(l, nowMs))
  return leases.length === store.leases.length ? store : { leases }
}

//
// Public API
//

/**
 * Claim a set of path globs for `agentId` on `team`, atomically. Globs are
 * normalized to repo-relative-against-`base` POSIX form (base defaults to the
 * stable getProjectRoot() so claim + guard share ONE namespace across cwd/worktree
 * changes — see the base comment below). Fails with a conflict if ANY requested glob overlaps a glob
 * held by ANOTHER (non-expired) agent — an agent never conflicts with itself,
 * so re-claiming REPLACES that agent's prior lease (renewing its TTL).
 *
 * Globs that escape `base` (`..`-prefixed) or are empty after normalization
 * are dropped. Claiming an empty set releases the agent's lease.
 */
export async function claimLease(
  team: string,
  agentId: string,
  globs: string[],
  opts: { base?: string; ttlMs?: number } = {},
): Promise<ClaimLeaseResult> {
  // STABLE base — getProjectRoot() (not getCwd()): the lease namespace must be IDENTICAL
  // for the claim side and the guard side regardless of an agent's cwd. getCwd() changes
  // on a mid-session worktree-entry / cd, splitting the namespace so the guard relScope'd
  // an edit path differently from the stored lease glob → it FALSE-ALLOWED a leased edit
  // (a fail-OPEN hole on a safety gate). getProjectRoot() is stable across worktree entry,
  // so claim + guard share one coordinate system. (See leaseGlob header: ONE namespace.)
  const base = opts.base ?? getProjectRoot()
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const normalized = Array.from(
    new Set(
      globs
        .map(g => relScope(g, base))
        .filter(g => g !== '' && g !== '..' && !g.startsWith('../')),
    ),
  )

  return withLockedStore<ClaimLeaseResult>(team, store => {
    const now = Date.now()
    const live = pruneExpired(store, now)

    // Check every requested glob against every OTHER agent's globs.
    for (const other of live.leases) {
      if (other.agentId === agentId) continue
      for (const og of other.globs) {
        for (const ng of normalized) {
          if (globsOverlap(og, ng)) {
            return {
              store: live, // persist the prune even on conflict
              result: {
                ok: false as const,
                conflict: { agentId: other.agentId, glob: og },
              },
            }
          }
        }
      }
    }

    // No conflict — replace this agent's lease (idempotent re-claim renews TTL).
    const without = live.leases.filter(l => l.agentId !== agentId)
    if (normalized.length === 0) {
      // Empty claim ⇒ release.
      return {
        store: { leases: without },
        result: {
          ok: true as const,
          lease: { agentId, globs: [], ts: new Date(now).toISOString(), ttlMs },
        },
      }
    }
    const lease: Lease = {
      agentId,
      globs: normalized,
      ts: new Date(now).toISOString(),
      ttlMs,
    }
    return {
      store: { leases: [...without, lease] },
      result: { ok: true as const, lease },
    }
  })
}

/** Release `agentId`'s lease on `team` (idempotent no-op if none). Returns true if one was dropped. */
export async function releaseLease(team: string, agentId: string): Promise<boolean> {
  return withLockedStore(team, store => {
    const before = store.leases.length
    const leases = store.leases.filter(l => l.agentId !== agentId)
    return { store: { leases }, result: leases.length !== before }
  })
}

/** Alias for releaseLease — drops ALL leases held by a single agent (an agent holds at most one record). */
export async function releaseAllForAgent(team: string, agentId: string): Promise<boolean> {
  return releaseLease(team, agentId)
}

/**
 * Return the conflicting {agentId, glob} for `filePath` on `team`, or null if
 * no OTHER agent's (non-expired) lease covers it. An agent never conflicts with
 * itself. Empty store / no leases ⇒ null (everything allowed). Lock-free read.
 */
export async function getLeaseConflict(
  team: string,
  agentId: string,
  filePath: string,
  opts: { base?: string; nowMs?: number } = {},
): Promise<LeaseConflict | null> {
  // STABLE base — getProjectRoot() (not getCwd()): the lease namespace must be IDENTICAL
  // for the claim side and the guard side regardless of an agent's cwd. getCwd() changes
  // on a mid-session worktree-entry / cd, splitting the namespace so the guard relScope'd
  // an edit path differently from the stored lease glob → it FALSE-ALLOWED a leased edit
  // (a fail-OPEN hole on a safety gate). getProjectRoot() is stable across worktree entry,
  // so claim + guard share one coordinate system. (See leaseGlob header: ONE namespace.)
  const base = opts.base ?? getProjectRoot()
  const now = opts.nowMs ?? Date.now()
  const rel = relScope(filePath, base)
  // A path outside the repo namespace can't match any in-namespace lease.
  if (rel === '..' || rel.startsWith('../')) return null

  const store = await leaseStoreFor(team).read()
  for (const lease of store.leases) {
    if (lease.agentId === agentId) continue
    if (isLeaseExpired(lease, now)) continue
    for (const glob of lease.globs) {
      if (globMatchesFile(glob, rel)) {
        return { agentId: lease.agentId, glob }
      }
    }
  }
  return null
}

/** List all current (non-expired) leases on `team`. Lock-free read. */
export async function listLeases(
  team: string,
  opts: { nowMs?: number } = {},
): Promise<Lease[]> {
  const now = opts.nowMs ?? Date.now()
  const store = await leaseStoreFor(team).read()
  return store.leases.filter(l => !isLeaseExpired(l, now))
}

/**
 * TTL sweep: prune expired (stale, dead-agent) leases from disk. Returns the
 * number removed. Safe to call opportunistically; a no-op when nothing is
 * stale. Takes the lock so the prune is atomic against concurrent claims.
 */
export async function sweepExpiredLeases(
  team: string,
  opts: { nowMs?: number } = {},
): Promise<number> {
  const now = opts.nowMs ?? Date.now()
  return withLockedStore(team, store => {
    const pruned = pruneExpired(store, now)
    return {
      store: pruned,
      result: store.leases.length - pruned.leases.length,
    }
  })
}
