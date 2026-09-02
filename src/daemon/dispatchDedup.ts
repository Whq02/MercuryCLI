
import { join } from 'node:path'
import { defineStore } from '../substrate/fileStore.js'
import { getTeamsDir } from '../utils/envUtils.js'
import { sanitizePathComponent } from '../utils/tasks.js'
import { getTeamName } from '../utils/teammate.js'

export type DispatchConsumptionState = 'delivering' | 'delivered'

type DedupEntry = { id: string; state: DispatchConsumptionState; at: string }
type DedupFile = { entries: DedupEntry[] }

const MAX_ENTRIES = 500

const dedupStore = defineStore<DedupFile, [string, string | undefined]>({
  name: 'dispatch-dedup',
  path: (agentName, teamName) => {
    const team = sanitizePathComponent(teamName || getTeamName() || 'default')
    const agent = sanitizePathComponent(agentName)
    return join(getTeamsDir(), team, 'dedup', `${agent}.json`)
  },
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const entries = (raw as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return { entries: [] }
    return {
      entries: entries.filter(
        (e): e is DedupEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as DedupEntry).id === 'string' &&
          ((e as DedupEntry).state === 'delivering' || (e as DedupEntry).state === 'delivered'),
      ),
    }
  },
  empty: () => ({ entries: [] }),
  onReadFailure: 'empty',
})

export interface DispatchDedup {
  stateOf(id: string): Promise<DispatchConsumptionState | null>
  begin(id: string): Promise<void>
  complete(id: string): Promise<void>
}

export function dispatchDedup(agentName: string, teamName?: string): DispatchDedup {
  const store = dedupStore(agentName, teamName)
  const set = (id: string, state: DispatchConsumptionState) =>
    store.mutate(file => {
      const existing = file.entries.find(e => e.id === id)
      if (existing?.state === state) return file
      if (existing?.state === 'delivered' && state === 'delivering') return file
      const entries = file.entries.filter(e => e.id !== id)
      entries.push({ id, state, at: new Date().toISOString() })
      return { entries: entries.slice(-MAX_ENTRIES) }
    })
  return {
    stateOf: async id =>
      (await store.read()).entries.find(e => e.id === id)?.state ?? null,
    begin: id => set(id, 'delivering'),
    complete: id => set(id, 'delivered'),
  }
}
