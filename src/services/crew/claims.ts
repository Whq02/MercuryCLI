import { getProjectRoot } from '../../bootstrap/state.js'
import {
  claimLease,
  DEFAULT_LEASE_TTL_MS,
  getLeaseConflict,
  getLeaseScopeConflict,
  getLeaseStorePath,
  listLeases,
  releaseLease,
  resolveClaimHolder,
  subscribeLeases,
  sweepExpiredLeases,
  type CrewClaimHolder,
  type CrewClaimHolderKind,
  type Lease,
} from '../../utils/swarm/leaseGlob.js'

export type { CrewClaimHolder, CrewClaimHolderKind }
export { resolveClaimHolder, DEFAULT_LEASE_TTL_MS }

export const CREW_CLAIMS_SCOPE = 'crew'

export interface CrewClaimV1 {
  holder: CrewClaimHolder
  globs: string[]
  ts: string
  ttlMs?: number
}

export interface CrewClaimConflict {
  holder: CrewClaimHolder
  glob: string
}

export type CrewClaimResult =
  | { ok: true; claim: CrewClaimV1 }
  | { ok: false; conflict: CrewClaimConflict; message: string }

function rowOf(lease: Lease): CrewClaimV1 {
  return { holder: lease.holder, globs: lease.globs, ts: lease.ts, ...(lease.ttlMs !== undefined ? { ttlMs: lease.ttlMs } : {}) }
}

export function crewClaimWords(filePath: string, holder: CrewClaimHolder): string {
  return `${filePath} is claimed by ${holder.name}; ask ${holder.name} or wait for the release.`
}

export function crewClaimStorePath(): string {
  return getLeaseStorePath(CREW_CLAIMS_SCOPE)
}

export async function claimCrewFiles(
  globs: readonly string[],
  opts: { holder?: CrewClaimHolder; base?: string; ttlMs?: number } = {},
): Promise<CrewClaimResult> {
  const holder = opts.holder ?? resolveClaimHolder()
  const result = await claimLease(CREW_CLAIMS_SCOPE, holder.name, [...globs], {
    holder,
    base: opts.base ?? getProjectRoot(),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  })
  if (result.ok) return { ok: true, claim: rowOf(result.lease) }
  return {
    ok: false,
    conflict: { holder: result.conflict.holder, glob: result.conflict.glob },
    message: crewClaimWords(result.conflict.glob, result.conflict.holder),
  }
}

export async function releaseCrewClaims(holder: CrewClaimHolder = resolveClaimHolder()): Promise<boolean> {
  return releaseLease(CREW_CLAIMS_SCOPE, holder.name)
}

export async function listCrewClaims(opts: { nowMs?: number } = {}): Promise<CrewClaimV1[]> {
  return (await listLeases(CREW_CLAIMS_SCOPE, opts)).map(rowOf)
}

export async function sweepCrewClaims(opts: { nowMs?: number } = {}): Promise<number> {
  return sweepExpiredLeases(CREW_CLAIMS_SCOPE, opts)
}

export async function crewClaimConflict(
  filePath: string,
  holder: CrewClaimHolder = resolveClaimHolder(),
  opts: { base?: string; nowMs?: number } = {},
): Promise<CrewClaimConflict | null> {
  const conflict = await getLeaseConflict(CREW_CLAIMS_SCOPE, holder.name, filePath, opts)
  return conflict ? { holder: conflict.holder, glob: conflict.glob } : null
}

export async function crewClaimScopeConflict(
  scopePath: string,
  holder: CrewClaimHolder = resolveClaimHolder(),
  opts: { base?: string; nowMs?: number } = {},
): Promise<CrewClaimConflict | null> {
  const conflict = await getLeaseScopeConflict(CREW_CLAIMS_SCOPE, holder.name, scopePath, opts)
  return conflict ? { holder: conflict.holder, glob: conflict.glob } : null
}

export function subscribeCrewClaims(listener: () => void): () => void {
  return subscribeLeases(CREW_CLAIMS_SCOPE, listener)
}
