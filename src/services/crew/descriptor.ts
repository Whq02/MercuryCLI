
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
  revision: number
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

export function subscribeSessionDescriptors(cb: () => void, opts?: { dir?: string }): () => void {
  return descriptorStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

export function renderSessionTitle(labels: {
  agentLabel: string
  missionLabel?: string
  worktreeLabel?: string
}): string {
  return [labels.agentLabel, labels.missionLabel, labels.worktreeLabel]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(' · ')
}
