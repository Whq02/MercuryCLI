import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineStore } from '../substrate/fileStore.js'
import { logForDebugging } from '../utils/debug.js'
import { pointerCitations } from './memoryCitations.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'

export const SIGNAL_TURN_LIMIT = 512

export interface SignalFeatures {
  bm25: number
  recency: number
  pinned: boolean
  kind: 'fact' | 'ruling' | 'pending' | 'handoff' | 'session'
}

interface SignalQuery {
  query: string
  offered: string[]
  features: Record<string, SignalFeatures>
}

export interface SignalTurn {
  queries: SignalQuery[]
  opened: string[]
  cited: string[]
}

export interface SignalCounts {
  offered: number
  opened: number
  cited: number
}

type Draft = { queries: SignalQuery[]; opened: Set<string>; scores: Map<string, Record<string, SignalFeatures>> }
const scope = new AsyncLocalStorage<Map<string, Draft>>()
const validId = /^(?:seq:[1-9]\d*|ledger:[1-9]\d*|doc:(?:archive\/)?[a-z0-9-]+|pending:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/

export function signalLogPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'signals.json')
}

function cleanIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && validId.test(id)))] : []
}

function cleanFeatures(value: unknown): Record<string, SignalFeatures> {
  const out: Record<string, SignalFeatures> = {}
  if (!value || typeof value !== 'object') return out
  for (const [id, f] of Object.entries(value) as Array<[string, SignalFeatures]>) {
    if (!validId.test(id) || !f || !Number.isFinite(f.bm25) || !Number.isFinite(f.recency) || typeof f.pinned !== 'boolean' || !['fact', 'ruling', 'pending', 'handoff', 'session'].includes(f.kind)) continue
    out[id] = { bm25: f.bm25, recency: f.recency, pinned: f.pinned, kind: f.kind }
  }
  return out
}

type SignalFile = { version: 1; turns: SignalTurn[] }

function decodeSignalLog(raw: unknown): SignalFile | null {
  const file = raw as Partial<SignalFile> | null
  if (file?.version !== 1 || !Array.isArray(file.turns)) return null
  const turns = file.turns.slice(-SIGNAL_TURN_LIMIT).flatMap(row => {
    if (!row || !Array.isArray(row.queries)) return []
    const opened = cleanIds(row.opened)
    return [{
      queries: row.queries.filter(q => q && typeof q.query === 'string' && /^[a-f0-9]{64}$/.test(q.query)).map(q => ({ query: q.query, offered: cleanIds(q.offered), features: cleanFeatures(q.features) })),
      opened,
      cited: cleanIds(row.cited).filter(id => opened.includes(id)),
    }]
  })
  return { version: 1, turns }
}

const signalStore = defineStore<SignalFile, [string]>({
  name: 'memory signals', path: signalLogPath, schemaVersion: 1,
  decode: decodeSignalLog, empty: () => ({ version: 1, turns: [] }), onReadFailure: 'throw',
})

export function readSignalLog(dir: string = mnemeLibraryDir()): SignalTurn[] {
  try {
    return decodeSignalLog(JSON.parse(readFileSync(signalLogPath(dir), 'utf8')))?.turns ?? []
  } catch {
    return []
  }
}

export function signalCounts(turns: readonly SignalTurn[]): Record<string, SignalCounts> {
  const counts: Record<string, SignalCounts> = {}
  for (const turn of turns) {
    for (const [field, ids] of [['offered', turn.queries.flatMap(q => q.offered)], ['opened', turn.opened], ['cited', turn.cited]] as const) {
      for (const id of new Set(ids)) {
        const row = counts[id] ??= { offered: 0, opened: 0, cited: 0 }
        row[field]++
      }
    }
  }
  return counts
}

function draftFor(dir: string): Draft | undefined {
  const current = scope.getStore()
  if (!current || !mnemeEnabled()) return undefined
  let draft = current.get(dir)
  if (!draft) {
    draft = { queries: [], opened: new Set(), scores: new Map() }
    current.set(dir, draft)
  }
  return draft
}

function queryId(query: string): string {
  return createHash('sha256').update(query).digest('hex')
}

export function noteMemoryScores(query: string, hits: readonly { id: string; features: SignalFeatures }[], dir: string = mnemeLibraryDir()): void {
  const draft = draftFor(dir)
  if (draft) draft.scores.set(queryId(query), cleanFeatures(Object.fromEntries(hits.map(hit => [hit.id, hit.features]))))
}

export function noteMemoryOffered(query: string, hits: readonly { id: string; features?: SignalFeatures }[], dir: string = mnemeLibraryDir()): void {
  if (hits.length === 0) return
  const draft = draftFor(dir)
  if (!draft) return
  const offered = cleanIds(hits.map(hit => hit.id))
  const id = queryId(query)
  const scored = draft.scores.get(id) ?? {}
  const features = cleanFeatures(Object.fromEntries(hits.map(hit => [hit.id, hit.features ?? scored[hit.id]])))
  draft.queries.push({ query: id, offered, features })
}

export function noteMemoryOpened(ids: readonly string[], dir: string = mnemeLibraryDir()): void {
  const draft = draftFor(dir)
  if (draft) for (const id of cleanIds(ids)) draft.opened.add(id)
}

export async function finishMemorySignal(answer: string): Promise<void> {
  const current = scope.getStore()
  if (!current || !mnemeEnabled()) return
  const citations = pointerCitations(answer)
  const drafts = [...current]
  current.clear()
  for (const [dir, draft] of drafts) {
    if (draft.queries.length === 0 && draft.opened.size === 0) continue
    try {
      const turn: SignalTurn = { queries: draft.queries, opened: [...draft.opened], cited: [...draft.opened].filter(id => citations.has(id)) }
      await signalStore(dir).mutate(file => ({ version: 1, turns: [...file.turns, turn].slice(-SIGNAL_TURN_LIMIT) }))
    } catch (error) {
      logForDebugging(`memory signal write failed: ${String(error)}`)
    }
  }
}

export async function* memorySignalScope<T, R>(iterator: AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  const current = new Map<string, Draft>()
  try {
    while (true) {
      const result = await scope.run(current, () => iterator.next())
      if (result.done) return result.value
      yield result.value
    }
  } finally {
    current.clear()
    await scope.run(current, () => iterator.return(undefined as R))
  }
}
