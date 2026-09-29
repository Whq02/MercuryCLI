
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { crewStoreRoot } from '../../services/crew/identity.js'
import { defineStore } from '../../substrate/fileStore.js'
import { getAgentContext, isSubagentContext } from '../agentContext.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { crewChildName, getDynamicTeamContext, getTeammateContext, resolveCoordAgentId } from '../teammate.js'
import { isCrewRole } from '../workerRole.js'

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000

export const CREW_CLAIM_HOLDER_KINDS = ['lead', 'crewmate', 'seat', 'subagent'] as const
export type CrewClaimHolderKind = (typeof CREW_CLAIM_HOLDER_KINDS)[number]

export type CrewClaimHolder = {
  name: string
  kind: CrewClaimHolderKind
  id?: string
}

export type Lease = {
  agentId: string
  holder: CrewClaimHolder
  globs: string[]
  ts: string
  ttlMs?: number
}

export type LeaseConflict = {
  agentId: string
  glob: string
  holder: CrewClaimHolder
}

export function resolveClaimHolder(): CrewClaimHolder {
  const name = resolveCoordAgentId()
  const agent = getAgentContext()
  if (isSubagentContext(agent) && agent.agentId === name) return { name, kind: 'subagent', id: agent.agentId }
  const inProcess = getTeammateContext()
  if (inProcess && inProcess.agentName === name) return { name, kind: 'crewmate', id: inProcess.agentId }
  const dynamic = getDynamicTeamContext()
  if (dynamic && dynamic.agentName === name) return { name, kind: isCrewRole() ? 'seat' : 'crewmate', id: dynamic.agentId }
  if (crewChildName() === name) return { name, kind: 'seat' }
  return { name, kind: 'lead' }
}

function holderFor(agentId: string, explicit?: CrewClaimHolder): CrewClaimHolder {
  if (explicit) return { ...explicit, name: agentId }
  const own = resolveClaimHolder()
  return own.name === agentId ? own : { name: agentId, kind: 'crewmate' }
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

export function crewClaimStoreKey(projectRoot: string = getProjectRoot()): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
}

export function getLeaseStorePath(team: string): string {
  void team
  return join(crewStoreRoot(), `claims-${crewClaimStoreKey()}.json`)
}

function decodeHolder(raw: unknown, agentId: string): CrewClaimHolder {
  const h = raw as Partial<CrewClaimHolder> | null | undefined
  const kind = h && typeof h === 'object' && typeof h.kind === 'string' && (CREW_CLAIM_HOLDER_KINDS as readonly string[]).includes(h.kind) ? (h.kind as CrewClaimHolderKind) : 'crewmate'
  const name = h && typeof h === 'object' && typeof h.name === 'string' && h.name !== '' ? h.name : agentId
  return { name, kind, ...(h && typeof h === 'object' && typeof h.id === 'string' ? { id: h.id } : {}) }
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
      leases: parsed.leases
        .filter(
          (l): l is Lease =>
            !!l &&
            typeof l.agentId === 'string' &&
            Array.isArray(l.globs) &&
            typeof l.ts === 'string',
        )
        .map(l => ({ ...l, holder: decodeHolder(l.holder, l.agentId) })),
    }
  },
  empty: () => ({ leases: [] }),
  onReadFailure: 'empty',
})

const releaseAtEnd = new Set<string>()

function releaseWhenThisProcessEnds(team: string, holder: CrewClaimHolder): void {
  if (holder.name !== resolveClaimHolder().name || releaseAtEnd.has(holder.name)) return
  releaseAtEnd.add(holder.name)
  registerCleanup(async () => {
    try {
      await releaseLease(team, holder.name)
    } catch (error) {
      logForDebugging(`crew claim release for ${holder.name} at process end failed: ${String(error)}`)
    }
  })
}

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
  opts: { base?: string; ttlMs?: number; holder?: CrewClaimHolder } = {},
): Promise<ClaimLeaseResult> {
  const holder = holderFor(agentId, opts.holder)
  const base = opts.base ?? getProjectRoot()
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const normalized = Array.from(
    new Set(
      globs
        .map(g => relScope(g, base))
        .filter(g => g !== '' && g !== '..' && !g.startsWith('../')),
    ),
  )

  const result = await withLockedStore<ClaimLeaseResult>(team, store => {
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
                conflict: { agentId: other.agentId, glob: og, holder: other.holder },
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
          lease: { agentId, holder, globs: [], ts: new Date(now).toISOString(), ttlMs },
        },
      }
    }
    const lease: Lease = {
      agentId,
      holder,
      globs: normalized,
      ts: new Date(now).toISOString(),
      ttlMs,
    }
    return {
      store: { leases: [...without, lease] },
      result: { ok: true as const, lease },
    }
  })
  if (result.ok && result.lease.globs.length > 0) releaseWhenThisProcessEnds(team, holder)
  return result
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
        return { agentId: lease.agentId, glob, holder: lease.holder }
      }
    }
  }
  return null
}

export function subscribeLeases(team: string, listener: () => void): () => void {
  return leaseStoreFor(team).subscribe(() => listener(), { immediate: false })
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
