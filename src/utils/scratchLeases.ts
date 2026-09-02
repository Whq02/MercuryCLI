// ============================================================================
//  scratchLeases — the scratch-space lease registry (, field row
// 657MB of agent scratch accumulated in /tmp with no owner, no
//  inventory, no cleanup policy).
//
//  Laws:
//   · every Mercury-created scratch root is REGISTERED: stable lease id,
//     owner (session/agent/task), root, created/last-used, cleanup policy;
//   · cleanup is LEASE-EXACT — only a registered root, only under the
//     project temp dir (the bun-homedir lesson: an explicit containment
//     guard before ANY delete), never a broad pattern sweep;
//   · on interruption the lease is PRESERVED and surfaced (path + size +
//     owner + recovery note) — the doctor lists leftovers;
//   · the registry itself is a versioned, atomically-published JSON beside
//     the scratch roots it describes.
// ============================================================================

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
  /** 'on-complete' roots are cleaned at release; 'preserve' roots are kept
   *  and surfaced (operator artifacts). */
  cleanupPolicy: 'on-complete' | 'preserve'
  /** One line the doctor shows when the lease outlives its owner. */
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
  // Durable publication — collision-free temp, win32 retry.
  durableAtomicPublishSync(registryPath(), JSON.stringify(file, null, 1))
}

/** Register (or refresh) a lease. Idempotent per (owner, root). */
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

/**
 * Release a lease. Cleanup is LEASE-EXACT: the root must be the registered
 * one AND live under the project temp dir — an out-of-containment root is
 * NEVER deleted (the registry row is dropped and the refusal is returned).
 */
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
  // Bounded walk — an inventory, not an audit; caps runaway trees.
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
        /* raced */
      }
    }
  }
  return total
}

/** Leases whose roots still exist on disk — the doctor's leftover surface. */
export function listScratchLeftovers(): ScratchLeftover[] {
  return loadRegistry()
    .filter(l => existsSync(l.root))
    .map(l => ({ ...l, sizeBytes: dirSizeBytes(l.root) }))
}
