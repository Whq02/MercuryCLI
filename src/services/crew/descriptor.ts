// ============================================================================
//  crew/descriptor — the versioned session descriptor + the ONE title
//  renderer.
//
//  A descriptor is METADATA: {agentId, sessionId, missionRef?, worktreeRef?,
//  revision}. The same record feeds the cockpit, the terminal session list,
//  ACP and VS Code. Laws:
//    · publications COALESCE (an unchanged publication is a no-op; a changed
//      one bumps the revision) and persist durably enough to survive
//      reconnects (the crew fileStore substrate);
//    · ONE pure renderer emits `Agent · Mission · Worktree` from resolved
//      labels — neither mutable labels nor the rendered title become a second
//      durable source of truth (the renderer takes labels, stores none);
//    · raw historic events keep the label that was emitted then; live
//      surfaces resolve the CURRENT display label (rename never rewrites
//      history — labels come from displayLabelsOf at render time);
//    · width/truncation belong to Mercury's terminal-width owners at the
//      surfaces — the renderer never truncates;
//    · the descriptor is never injected into model instructions to name a
//      session.
// ============================================================================

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { crewStoreRoot, type CrewAgentId } from './identity.js'

export interface SessionDescriptorV1 {
  schema: 1
  agentId: CrewAgentId
  sessionId: string
  missionRef?: string
  worktreeRef?: string
  /** Bumped on every CHANGED publication — unchanged publications coalesce. */
  revision: number
  /** Set when the session ended or the record was superseded (a seat's
   *  placeholder id replaced by the proven external id) — retired records
   *  evict FIRST, live ones never ahead of them (wave B). */
  retiredAt?: number
  updatedAt: number
}

interface DescriptorFile {
  descriptors: Record<string, SessionDescriptorV1>
}

const MAX_DESCRIPTORS = 300

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

const descriptorStore = defineStore<DescriptorFile, [dir?: string]>({
  name: 'crew-session-descriptors',
  path: (dir?: string) =>
    join(crewStoreRoot(dir), `descriptors-${projectKey()}.json`),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as { descriptors?: unknown }
    const out: DescriptorFile = { descriptors: {} }
    if (r.descriptors && typeof r.descriptors === 'object' && !Array.isArray(r.descriptors)) {
      for (const [id, d] of Object.entries(r.descriptors)) {
        if (d && typeof d === 'object' && typeof (d as SessionDescriptorV1).agentId === 'string') {
          out.descriptors[id] = d as SessionDescriptorV1
        }
      }
    }
    return out
  },
  empty: () => ({ descriptors: {} }),
  onReadFailure: 'empty',
})

/**
 * Publish (idempotently — coalesced by content, revisioned on change). The
 * sessionId keys the record; a changed mission/worktree/agent bumps the
 * revision so reconnecting surfaces can cheaply detect movement.
 */
export async function publishSessionDescriptor(
  args: {
    agentId: CrewAgentId
    sessionId: string
    missionRef?: string
    worktreeRef?: string
  },
  opts?: { dir?: string },
): Promise<SessionDescriptorV1> {
  const store = descriptorStore(opts?.dir)
  return store.update<SessionDescriptorV1>(current => {
    const existing = current.descriptors[args.sessionId]
    if (
      existing &&
      existing.retiredAt === undefined &&
      existing.agentId === args.agentId &&
      existing.missionRef === args.missionRef &&
      existing.worktreeRef === args.worktreeRef
    ) {
      // Retirement is CONTENT for the coalesce: a publish on a RETIRED id is
      // a recovery (the session is live again) and must fall through to a
      // fresh revision with retiredAt cleared — coalescing it kept a
      // recovered seat reading historical forever (final audit).
      return { next: current, result: existing }
    }
    const published: SessionDescriptorV1 = {
      schema: 1,
      agentId: args.agentId,
      sessionId: args.sessionId,
      ...(args.missionRef !== undefined ? { missionRef: args.missionRef } : {}),
      ...(args.worktreeRef !== undefined ? { worktreeRef: args.worktreeRef } : {}),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    }
    let descriptors = { ...current.descriptors, [args.sessionId]: published }
    const ids = Object.keys(descriptors)
    if (ids.length > MAX_DESCRIPTORS) {
      // RETIRED records evict first (oldest first); a live session's
      // descriptor drops only when no retired victim remains.
      const byAge = Object.values(descriptors).sort((a, b) => a.updatedAt - b.updatedAt)
      let toDrop = byAge.length - MAX_DESCRIPTORS
      const dropSet = new Set<SessionDescriptorV1>()
      for (const d of byAge) {
        if (toDrop === 0) break
        if (d.sessionId !== args.sessionId && d.retiredAt !== undefined) {
          dropSet.add(d)
          toDrop--
        }
      }
      for (const d of byAge) {
        if (toDrop === 0) break
        if (d.sessionId !== args.sessionId && !dropSet.has(d)) {
          dropSet.add(d)
          toDrop--
        }
      }
      descriptors = {}
      for (const d of byAge) {
        if (!dropSet.has(d)) descriptors[d.sessionId] = d
      }
      descriptors[args.sessionId] = published
    }
    return { next: { ...current, descriptors }, result: published }
  })
}

/** Retire a descriptor (session ended, or a seat placeholder superseded by
 *  the proven external id) — retired records evict first and read as
 *  historical, never live. */
export async function retireSessionDescriptor(
  sessionId: string,
  opts?: { dir?: string },
): Promise<void> {
  const store = descriptorStore(opts?.dir)
  await store.mutate(current => {
    const d = current.descriptors[sessionId]
    if (!d || d.retiredAt !== undefined) return current
    return {
      ...current,
      descriptors: { ...current.descriptors, [sessionId]: { ...d, retiredAt: Date.now() } },
    }
  })
}

export async function readSessionDescriptor(
  sessionId: string,
  opts?: { dir?: string },
): Promise<SessionDescriptorV1 | null> {
  const file = await descriptorStore(opts?.dir).read()
  return file.descriptors[sessionId] ?? null
}

export async function listSessionDescriptors(opts?: {
  dir?: string
}): Promise<SessionDescriptorV1[]> {
  const file = await descriptorStore(opts?.dir).read()
  return Object.values(file.descriptors)
}

/** Subscription seam (single-owner store discipline). */
export function subscribeSessionDescriptors(cb: () => void, opts?: { dir?: string }): () => void {
  return descriptorStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

/**
 * THE one pure title renderer: `Agent · Mission · Worktree`, absent parts
 * elided (never placeholder dashes). Labels arrive RESOLVED (the caller reads
 * displayLabelsOf / mission / worktree owners live) — this function stores
 * nothing and truncates nothing (width belongs to the terminal-width owners
 * at the surface).
 */
export function renderSessionTitle(labels: {
  agentLabel: string
  missionLabel?: string
  worktreeLabel?: string
}): string {
  return [labels.agentLabel, labels.missionLabel, labels.worktreeLabel]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(' · ')
}
