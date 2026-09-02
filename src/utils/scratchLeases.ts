
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { getProjectTempDir } from './permissions/filesystem.js'

export const SCRATCH_LEASE_REGISTRY_VERSION = 1

export interface ScratchLease {
  leaseId: string
  owner: { kind: 'session' | 'agent' | 'task'; id: string }
  root: string
  createdAt: number
  lastUsedAt: number
  cleanupPolicy: 'on-complete' | 'preserve'
  recovery: string
}

interface RegistryFile {
  v: typeof SCRATCH_LEASE_REGISTRY_VERSION
  leases: ScratchLease[]
}

function registryPath(): string {
  return join(getProjectTempDir(), 'scratch-leases.json')
}

function loadRegistry(): ScratchLease[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf8')) as RegistryFile
    if (parsed?.v !== SCRATCH_LEASE_REGISTRY_VERSION || !Array.isArray(parsed.leases)) return []
    return parsed.leases
  } catch {
    return []
  }
}

function publishRegistry(leases: ScratchLease[]): void {
  const file: RegistryFile = { v: SCRATCH_LEASE_REGISTRY_VERSION, leases }
  durableAtomicPublishSync(registryPath(), JSON.stringify(file, null, 1))
}

export function registerScratchLease(
  owner: ScratchLease['owner'],
  root: string,
  opts: { cleanupPolicy?: ScratchLease['cleanupPolicy']; recovery?: string } = {},
): ScratchLease {
  const leases = loadRegistry()
  const now = Date.now()
  const existing = leases.find(
    l => l.root === root && l.owner.kind === owner.kind && l.owner.id === owner.id,
  )
  if (existing) {
    existing.lastUsedAt = now
    publishRegistry(leases)
    return existing
  }
  const lease: ScratchLease = {
    leaseId: `sl-${now.toString(36)}-${Math.abs(root.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`,
    owner,
    root,
    createdAt: now,
    lastUsedAt: now,
    cleanupPolicy: opts.cleanupPolicy ?? 'on-complete',
    recovery: opts.recovery ?? 'safe to delete once the owner is gone (rm -rf the root)',
  }
  leases.push(lease)
  publishRegistry(leases)
  return lease
}

export function releaseScratchLease(
  leaseId: string,
  opts: { clean?: boolean } = {},
): { released: boolean; cleaned: boolean; refusal?: string } {
  const leases = loadRegistry()
  const idx = leases.findIndex(l => l.leaseId === leaseId)
  if (idx < 0) return { released: false, cleaned: false, refusal: `no lease '${leaseId}'` }
  const lease = leases[idx]!
  leases.splice(idx, 1)
  publishRegistry(leases)
  const clean = opts.clean ?? lease.cleanupPolicy === 'on-complete'
  if (!clean) return { released: true, cleaned: false }
  const containment = resolve(getProjectTempDir()) + sep
  const target = resolve(lease.root)
  if (!(target + sep).startsWith(containment)) {
    return {
      released: true,
      cleaned: false,
      refusal: `lease root ${lease.root} is OUTSIDE the project temp dir — refusing to delete (containment law)`,
    }
  }
  try {
    rmSync(target, { recursive: true, force: true })
    return { released: true, cleaned: true }
  } catch (e) {
    return { released: true, cleaned: false, refusal: `cleanup failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface ScratchLeftover extends ScratchLease {
  sizeBytes: number
}

function dirSizeBytes(root: string, budget = 20_000): number {
  let total = 0
  let visited = 0
  const stack = [root]
  while (stack.length > 0 && visited < budget) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (visited++ >= budget) break
      const p = join(dir, e)
      try {
        const st = statSync(p)
        if (st.isDirectory()) stack.push(p)
        else total += st.size
      } catch {
      }
    }
  }
  return total
}

export function listScratchLeftovers(): ScratchLeftover[] {
  return loadRegistry()
    .filter(l => existsSync(l.root))
    .map(l => ({ ...l, sizeBytes: dirSizeBytes(l.root) }))
}
