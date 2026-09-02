
import { join, relative, resolve } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { defineStore } from '../../substrate/fileStore.js'
import { getTeamDir, sanitizeName } from './teamHelpers.js'

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000

export type Lease = {
  agentId: string
  globs: string[]
  ts: string
  ttlMs?: number
}

export type LeaseConflict = {
  agentId: string
  glob: string
}

export type ClaimLeaseResult =
  | { ok: true; lease: Lease }
  | { ok: false; conflict: LeaseConflict }


export function relScope(p: string, base: string): string {
  return relative(base, resolve(base, String(p))).replace(/\\/g, '/')
}

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

function covers(pattern: string, target: string): boolean {
  const p = literalPrefix(pattern)
  const t = literalPrefix(target)
  if (p === '' || p === '.') return true
  return t === p || t.startsWith(p + '/')
}

export function globsOverlap(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a)
}

function globToRegExpSource(p: string): string {
  const GS_SLASH = '\x00GS\x00'
  const GS = '\x00G\x00'
  const STAR = '\x00S\x00'
  const Q = '\x00Q\x00'
  let s = p
    .replace(/(^|\/)\*\*\//g, (_m, lead: string) => (lead ? '/' : '') + GS_SLASH)
    .replace(/\*\*/g, GS)
    .replace(/\*/g, STAR)
    .replace(/\?/g, Q)
  s = s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
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

export function globMatchesFile(pattern: string, file: string): boolean {
  const f = String(file).replace(/\\/g, '/').replace(/\/+$/, '')
  const p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === '..' || p.startsWith('../')) return false
  if (p === '' || p === '.') return true
  const sub = p.replace(/\/\*\*?$/, '')
  if (sub !== p) return f === sub || f.startsWith(sub + '/')
  if (!/[*?]/.test(p)) return f === p || f.startsWith(p + '/')
  try {
    return new RegExp(globToRegExpSource(p)).test(f)
  } catch {
    return covers(p, f)
  }
}


export function isLeaseExpired(lease: Lease, nowMs: number): boolean {
  if (!lease || typeof lease !== 'object') return false
  if (typeof lease.ttlMs === 'number' && lease.ttlMs > 0 && lease.ts) {
    const start = Date.parse(lease.ts)
    return Number.isFinite(start) ? start + lease.ttlMs <= nowMs : false
  }
  return false
}


type LeaseStore = { leases: Lease[] }

function getLeasesDir(team: string): string {
  return join(getTeamDir(team), 'leases')
}

export function getLeaseStorePath(team: string): string {
  return join(getLeasesDir(team), 'leases.json')
}

const leaseStoreFor = defineStore<LeaseStore, [string]>({
  name: 'leaseGlob',
  path: team => getLeaseStorePath(team),
  schemaVersion: 1,
  decode: raw => {
    const parsed = raw as Partial<LeaseStore> | null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.leases)) {
      return null
    }
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

async function withLockedStore<T>(
  team: string,
  fn: (store: LeaseStore) => Promise<{ store: LeaseStore; result: T }> | { store: LeaseStore; result: T },
): Promise<T> {
  return leaseStoreFor(team).update(async store => {
    const { store: next, result } = await fn(store)
    return { next, result }
  })
}

function pruneExpired(store: LeaseStore, nowMs: number): LeaseStore {
  const leases = store.leases.filter(l => !isLeaseExpired(l, nowMs))
  return leases.length === store.leases.length ? store : { leases }
}


export async function claimLease(
  team: string,
  agentId: string,
  globs: string[],
  opts: { base?: string; ttlMs?: number } = {},
): Promise<ClaimLeaseResult> {
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

    for (const other of live.leases) {
      if (other.agentId === agentId) continue
      for (const og of other.globs) {
        for (const ng of normalized) {
          if (globsOverlap(og, ng)) {
            return {
              store: live,
              result: {
                ok: false as const,
                conflict: { agentId: other.agentId, glob: og },
              },
            }
          }
        }
      }
    }

    const without = live.leases.filter(l => l.agentId !== agentId)
    if (normalized.length === 0) {
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

export async function releaseLease(team: string, agentId: string): Promise<boolean> {
  return withLockedStore(team, store => {
    const before = store.leases.length
    const leases = store.leases.filter(l => l.agentId !== agentId)
    return { store: { leases }, result: leases.length !== before }
  })
}

export async function releaseAllForAgent(team: string, agentId: string): Promise<boolean> {
  return releaseLease(team, agentId)
}

export async function getLeaseConflict(
  team: string,
  agentId: string,
  filePath: string,
  opts: { base?: string; nowMs?: number } = {},
): Promise<LeaseConflict | null> {
  const base = opts.base ?? getProjectRoot()
  const now = opts.nowMs ?? Date.now()
  const rel = relScope(filePath, base)
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

export async function listLeases(
  team: string,
  opts: { nowMs?: number } = {},
): Promise<Lease[]> {
  const now = opts.nowMs ?? Date.now()
  const store = await leaseStoreFor(team).read()
  return store.leases.filter(l => !isLeaseExpired(l, now))
}

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
