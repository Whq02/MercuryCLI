import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { crewStoreRoot } from './identity.js'

export const LIVE_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type LiveTaskStatus = (typeof LIVE_TASK_STATUSES)[number]

export interface LiveCommsTaskV1 {
  id: string
  subject: string
  detail?: string
  status: LiveTaskStatus
  owner?: string
  blockedBy: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}

type LiveTasksFile = { tasks: LiveCommsTaskV1[] }

export function liveCommsCrewKey(crew: string): string {
  return crew.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

export function liveCommsTasksPath(crew: string, dir?: string): string {
  return join(crewStoreRoot(dir), 'livecomms', `${liveCommsCrewKey(crew)}.json`)
}

function decodeTask(raw: unknown, key: string): LiveCommsTaskV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const t = raw as Partial<LiveCommsTaskV1>
  const id = typeof t.id === 'string' && t.id !== '' ? t.id : key
  if (typeof t.subject !== 'string') return null
  const status = typeof t.status === 'string' && (LIVE_TASK_STATUSES as readonly string[]).includes(t.status) ? (t.status as LiveTaskStatus) : 'pending'
  return {
    id,
    subject: t.subject,
    ...(typeof t.detail === 'string' ? { detail: t.detail } : {}),
    status,
    ...(typeof t.owner === 'string' ? { owner: t.owner } : {}),
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter((b): b is string => typeof b === 'string') : [],
    createdBy: typeof t.createdBy === 'string' ? t.createdBy : '',
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
  }
}

const liveTasksStore = defineStore<LiveTasksFile, [string, string?]>({
  name: 'crew-live-tasks',
  path: (crew, dir) => liveCommsTasksPath(crew, dir),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const source = (raw as { tasks?: unknown }).tasks
    const entries: Array<[string, unknown]> = Array.isArray(source)
      ? source.map((t, i) => [String((t as { id?: unknown })?.id ?? i), t])
      : source && typeof source === 'object'
        ? Object.entries(source as Record<string, unknown>)
        : []
    return { tasks: entries.map(([key, t]) => decodeTask(t, key)).filter((t): t is LiveCommsTaskV1 => t !== null) }
  },
  empty: () => ({ tasks: [] }),
  onReadFailure: 'empty',
})

export async function listLiveCommsTasks(crew: string, opts: { dir?: string } = {}): Promise<LiveCommsTaskV1[]> {
  return (await liveTasksStore(crew, opts.dir).read()).tasks
}

export function subscribeLiveCommsTasks(crew: string, listener: () => void, opts: { dir?: string } = {}): () => void {
  return liveTasksStore(crew, opts.dir).subscribe(() => listener(), { immediate: false })
}
