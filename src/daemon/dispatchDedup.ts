/**
 * dispatchDedup — the DURABLE consumed-dispatch ledger (crash-consistency
 * FC4).
 *
 * The drain's exactly-once dedup would otherwise live in roster memory
 * (seenDispatchIds): a daemon that delivered a dispatch and died before the
 * mark-read acknowledgement REDELIVERED it after restart, and the fresh
 * child re-executed acted-on work. This ledger persists each dispatch's
 * consumption state per consumer:
 *
 *   'delivering'  recorded durably BEFORE the act (the stdin write) — a
 *                 crash in the act window redelivers WITH an honest replay
 *                 marker (at-least-once, never silently duplicated);
 *   'delivered'   recorded after the act — a restart consumes the
 *                 redelivery without re-executing (exactly-once from here).
 *
 * One small object store per consumer at `<team>/dedup/<agent>.json` —
 * deliberately OUTSIDE `inboxes/` (an inbox scan treats every inboxes/*.json
 * basename as an inbox). Bounded FIFO (500 ids).
 */

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
  /** Durably record 'delivering' BEFORE the act. Idempotent. */
  begin(id: string): Promise<void>
  /** Durably record 'delivered' after the act. Idempotent. */
  complete(id: string): Promise<void>
}

/** The durable dedup ledger for one consumer. */
export function dispatchDedup(agentName: string, teamName?: string): DispatchDedup {
  const store = dedupStore(agentName, teamName)
  const set = (id: string, state: DispatchConsumptionState) =>
    store.mutate(file => {
      const existing = file.entries.find(e => e.id === id)
      if (existing?.state === state) return file // no-op publish skipped
      if (existing?.state === 'delivered' && state === 'delivering') return file // never regress
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
