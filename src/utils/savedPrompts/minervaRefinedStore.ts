
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../envUtils.js'
import { projectSlug } from '../sessionStoragePortable.js'
import { MAX_SAVED_PROMPT_CHARS } from './savedPromptsStore.js'

export type MinervaRefinedSource = 'room' | 'chat' | 'boot'

export interface MinervaRefinedV1 {
  id: string
  original: string
  refined: string
  source: MinervaRefinedSource
  refinedAt: string
  noteRef?: string
}

export interface MinervaRefinedFile {
  entries: MinervaRefinedV1[]
}

export const MAX_MINERVA_REFINED = 100

export function minervaRefinedRoot(): string {
  return join(getMercuryHome(), 'minerva-refined')
}

export function minervaRefinedPath(projectPath: string): string {
  return join(minervaRefinedRoot(), `${projectSlug(projectPath.normalize('NFC'))}.json`)
}

const SOURCES: readonly MinervaRefinedSource[] = ['room', 'chat', 'boot']

function sanitizeEntry(raw: unknown): MinervaRefinedV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Partial<MinervaRefinedV1>
  if (typeof e.id !== 'string' || e.id.length === 0) return null
  if (typeof e.original !== 'string' || typeof e.refined !== 'string' || e.refined.trim().length === 0) return null
  return {
    id: e.id,
    original: e.original.slice(0, MAX_SAVED_PROMPT_CHARS),
    refined: e.refined.slice(0, MAX_SAVED_PROMPT_CHARS),
    source: SOURCES.includes(e.source as MinervaRefinedSource) ? (e.source as MinervaRefinedSource) : 'chat',
    refinedAt: typeof e.refinedAt === 'string' && e.refinedAt.length > 0 ? e.refinedAt : new Date(0).toISOString(),
    ...(typeof e.noteRef === 'string' && e.noteRef.length > 0 ? { noteRef: e.noteRef } : {}),
  }
}

const store = defineStore<MinervaRefinedFile, [projectPath: string]>({
  name: 'minerva-refined',
  path: (projectPath: string) => minervaRefinedPath(projectPath),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as { entries?: unknown }
    if (!Array.isArray(r.entries)) return null
    const seen = new Set<string>()
    const entries: MinervaRefinedV1[] = []
    for (const item of r.entries) {
      const e = sanitizeEntry(item)
      if (!e || seen.has(e.id)) continue
      seen.add(e.id)
      entries.push(e)
    }
    return { entries: entries.slice(-MAX_MINERVA_REFINED) }
  },
  empty: () => ({ entries: [] }),
  onReadFailure: 'empty',
})

export function newMinervaRefinedId(): string {
  return randomBytes(3).toString('hex')
}

export type MinervaRefinedReceipt = { ok: true; id: string } | { ok: false; reason: string }

export async function listMinervaRefined(projectPath: string): Promise<MinervaRefinedV1[]> {
  return (await store(projectPath).read()).entries
}

export async function appendMinervaRefined(
  projectPath: string,
  entry: { original: string; refined: string; source: MinervaRefinedSource; noteRef?: string },
): Promise<MinervaRefinedReceipt> {
  const refined = entry.refined.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SAVED_PROMPT_CHARS)
  if (refined.length === 0) return { ok: false, reason: 'an empty refinement lands nothing' }
  const original = entry.original.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SAVED_PROMPT_CHARS)
  return store(projectPath).update<MinervaRefinedReceipt>(current => {
    const newest = current.entries[current.entries.length - 1]
    if (newest !== undefined && newest.original === original && newest.refined === refined) {
      return { next: current, result: { ok: true as const, id: newest.id } }
    }
    const id = newMinervaRefinedId()
    const row: MinervaRefinedV1 = {
      id,
      original,
      refined,
      source: entry.source,
      refinedAt: new Date().toISOString(),
      ...(entry.noteRef !== undefined ? { noteRef: entry.noteRef } : {}),
    }
    return {
      next: { entries: [...current.entries, row].slice(-MAX_MINERVA_REFINED) },
      result: { ok: true as const, id },
    }
  })
}

export async function removeMinervaRefined(projectPath: string, id: string): Promise<MinervaRefinedReceipt> {
  return store(projectPath).update<MinervaRefinedReceipt>(current => {
    if (!current.entries.some(e => e.id === id)) {
      return { next: current, result: { ok: false as const, reason: 'that refinement is gone' } }
    }
    return { next: { entries: current.entries.filter(e => e.id !== id) }, result: { ok: true as const, id } }
  })
}


type Cached = { entries: MinervaRefinedV1[] | null; problem: string | null; listeners: Set<() => void>; stop: (() => void) | null }
const cache = new Map<string, Cached>()
const NO_ENTRIES: MinervaRefinedV1[] = []

function cell(projectPath: string): Cached {
  let c = cache.get(projectPath)
  if (!c) {
    c = { entries: null, problem: null, listeners: new Set(), stop: null }
    cache.set(projectPath, c)
  }
  return c
}

export function getMinervaRefinedSnapshot(projectPath: string): MinervaRefinedV1[] | null {
  return cell(projectPath).entries
}

export function getMinervaRefinedProblem(projectPath: string): string | null {
  return cell(projectPath).problem
}

export function subscribeMinervaRefined(projectPath: string, listener: () => void): () => void {
  const c = cell(projectPath)
  c.listeners.add(listener)
  if (c.stop === null) {
    c.stop = store(projectPath).subscribe(value => {
      c.entries = value.entries
      c.problem = null
      for (const l of c.listeners) l()
    })
    void store(projectPath)
      .readResult()
      .then(rr => {
        if (rr.state !== 'recoverable' || c.stop === null) return
        c.problem = rr.reason
        if (c.entries === null) c.entries = NO_ENTRIES
        for (const l of c.listeners) l()
      })
      .catch(() => {
      })
  }
  return () => {
    c.listeners.delete(listener)
    if (c.listeners.size === 0 && c.stop) {
      c.stop()
      c.stop = null
    }
  }
}

export function _resetMinervaRefinedCacheForProofs(): void {
  for (const c of cache.values()) c.stop?.()
  cache.clear()
}
