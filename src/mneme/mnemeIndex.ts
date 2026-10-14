import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { loadEmbedAddon } from './embedPack.js'
import { checkEmbedModel, describeSemanticReadiness, embedDefaultModel, resolveEmbedModelPin, WORD_MATCH_ONLY_WORDS } from './embedModels.js'
import { pendingRows } from './mnemeBuffer.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { listArchiveDocs, listTopicDocs, publishLibraryFile } from './mnemeLibrary.js'
import type { MnemeTopicDoc } from './mnemeTopicDocs.js'

export const INDEX_DIR = '.index'
export const INDEX_FILE = 'embeddings.json'
export const INDEX_VERSION = 2
export const INDEX_BUILDING_WORDS = 'index building…'
export const EMBED_IDLE_UNLOAD_MS = 5 * 60_000
const VECTOR_DECIMALS = 5
const BUILD_CHUNK = 4

export interface EmbeddingIndexRow {
  key: string
  h: string
  v: number[]
}

export interface EmbeddingIndexFile {
  version: typeof INDEX_VERSION
  model: string
  dimension: number
  rows: EmbeddingIndexRow[]
}

export interface IndexedFact {
  key: string
  text: string
}

export function indexPath(dir: string): string {
  return join(dir, INDEX_DIR, INDEX_FILE)
}

interface LoadedEngine {
  handle: number
  model: string
  dimension: number
}

let engine: LoadedEngine | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleUnloadMs = EMBED_IDLE_UNLOAD_MS
const building = new Map<string, Promise<RebuildOutcome>>()
let fileCache: { path: string; stamp: string; file: EmbeddingIndexFile | null } | null = null

export function resetEmbedIndexForTest(opts: { idleUnloadMs?: number } = {}): void {
  unloadEmbedIndexEngine()
  idleUnloadMs = opts.idleUnloadMs ?? EMBED_IDLE_UNLOAD_MS
  fileCache = null
}

export function unloadEmbedIndexEngine(): boolean {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (engine === null) return false
  const addon = loadEmbedAddon()
  try {
    if (addon.state === 'ok') addon.addon.unloadModel(engine.handle)
  } catch (error) {
    logForDebugging(`embed index engine unload failed: ${String(error)}`)
  }
  engine = null
  return true
}

export function embedIndexEngineLoaded(): boolean {
  return engine !== null
}

function touchEngine(): void {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (building.size === 0) unloadEmbedIndexEngine()
    else touchEngine()
  }, idleUnloadMs)
  idleTimer.unref?.()
}

export function embedIndexEngineStatus(): { state: 'ok'; model: string; dimension: number } | { state: 'off'; note: string } {
  const load = loadEmbedIndexEngine()
  return load === null ? { state: 'off', note: embedIndexOffNote() } : { state: 'ok', model: load.model, dimension: load.dimension }
}

export function embedIndexOffNote(): string {
  const addon = loadEmbedAddon()
  if (addon.state !== 'ok') return addon.note
  const check = checkEmbedModel(resolveEmbedModelPin())
  return check.state === 'present' ? 'the model is present but the engine refused it' : check.state === 'ollama' ? 'ollama models serve through their own road, not the derived index' : check.note
}

function loadEmbedIndexEngine(): LoadedEngine | null {
  if (engine !== null) {
    touchEngine()
    return engine
  }
  const addon = loadEmbedAddon()
  if (addon.state !== 'ok') return null
  const check = checkEmbedModel(resolveEmbedModelPin())
  if (check.state !== 'present') return null
  try {
    const handle = addon.addon.loadModel(check.path)
    const info = addon.addon.modelInfo(handle)
    engine = { handle, model: check.name, dimension: info.dimension }
    touchEngine()
    return engine
  } catch (error) {
    logForDebugging(`embed index engine load failed: ${String(error)}`)
    return null
  }
}

function roundVector(v: readonly number[]): number[] {
  const f = 10 ** VECTOR_DECIMALS
  return v.map(x => Math.round(x * f) / f)
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

export interface EmbedSearchRow {
  key: string
  sim: number
}

export function searchEmbedIndex(query: string, index: EmbeddingIndexFile, engineStatus: { state: 'ok'; model: string; dimension: number } | { state: 'off'; note: string }, limit = 8): EmbedSearchRow[] {
  const load = loadEmbedIndexEngine()
  const addon = loadEmbedAddon()
  if (load === null || addon.state !== 'ok' || engineStatus.state !== 'ok' || index.model !== load.model || index.dimension !== load.dimension) return []
  let q: number[]
  try {
    q = roundVector(addon.addon.embed(load.handle, query, true))
  } catch {
    return []
  }
  if (q.length !== index.dimension) return []
  const out: EmbedSearchRow[] = []
  for (const row of index.rows) {
    if (row.v.length !== index.dimension) continue
    out.push({ key: row.key, sim: cosine(q, row.v) })
  }
  out.sort((a, b) => b.sim - a.sim || a.key.localeCompare(b.key))
  return out.slice(0, limit)
}

function decodeIndexFile(raw: unknown): EmbeddingIndexFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as Partial<EmbeddingIndexFile> & { rows?: unknown }
  const dimension = f.dimension
  if (f.version !== INDEX_VERSION || typeof f.model !== 'string' || typeof dimension !== 'number' || !Number.isInteger(dimension) || dimension <= 0 || !Array.isArray(f.rows)) return null
  const rows: EmbeddingIndexRow[] = []
  const seen = new Set<string>()
  for (const row of f.rows) {
    if (typeof row !== 'object' || row === null) return null
    const r = row as Partial<EmbeddingIndexRow> & { v?: unknown }
    if (typeof r.key !== 'string' || !/^(seq:[1-9][0-9]*|pending:\S+)$/.test(r.key) || typeof r.h !== 'string' || !/^[0-9a-f]{16}$/.test(r.h) || !Array.isArray(r.v) || r.v.length !== dimension || !r.v.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) return null
    if (seen.has(r.key)) return null
    seen.add(r.key)
    rows.push({ key: r.key, h: r.h, v: r.v as number[] })
  }
  return { version: INDEX_VERSION, model: f.model, dimension, rows }
}

export function readEmbedIndex(dir: string): EmbeddingIndexFile | null {
  const path = indexPath(dir)
  let stamp: string
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
  if (fileCache !== null && fileCache.path === path && fileCache.stamp === stamp) return fileCache.file
  let file: EmbeddingIndexFile | null
  try {
    file = decodeIndexFile(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    file = null
  }
  fileCache = { path, stamp, file }
  return file
}

export interface IndexFreshness {
  current: boolean
  reason: string
  rows: number
}

function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function libraryFacts(dir: string, docs?: readonly MnemeTopicDoc[]): IndexedFact[] {
  const out: IndexedFact[] = []
  for (const doc of docs ?? [...listTopicDocs(dir), ...listArchiveDocs(dir)]) for (const s of doc.sections) for (const e of s.entries) out.push({ key: `seq:${e.seq}`, text: e.text })
  for (const row of pendingRows(dir)) out.push({ key: `pending:${row.ts}`, text: row.text })
  return out
}

export function embedIndexFreshness(index: EmbeddingIndexFile | null, facts: readonly IndexedFact[]): IndexFreshness {
  const live = new Map(facts.map(f => [f.key, textDigest(f.text)]))
  if (index === null) return { current: false, reason: 'absent', rows: 0 }
  if (index.model !== indexModelName()) return { current: false, reason: `built for ${index.model}, the pin now serves ${indexModelName()}`, rows: index.rows.length }
  const indexed = new Map(index.rows.map(r => [r.key, r.h]))
  const missing = [...live.keys()].filter(key => !indexed.has(key)).length
  const extra = [...indexed.keys()].filter(key => !live.has(key)).length
  const changed = [...live.entries()].filter(([key, h]) => indexed.get(key) !== undefined && indexed.get(key) !== h).length
  if (missing > 0 || extra > 0 || changed > 0) return { current: false, reason: `${missing} fact(s) unindexed, ${extra} indexed row(s) no longer live, ${changed} reworded`, rows: index.rows.length }
  return { current: true, reason: 'current', rows: index.rows.length }
}

export function indexModelName(): string {
  const pin = resolveEmbedModelPin()
  if (pin.kind === 'catalogue') return pin.row.name
  if (pin.kind === 'path') return pin.name
  if (pin.kind === 'ollama') return `ollama:${pin.model}`
  return embedDefaultModel().name
}

export interface RebuildOutcome {
  built: boolean
  rows: number
  ms: number
  reason: string
}

export function embedIndexBuilding(dir: string): boolean {
  return building.has(indexPath(dir))
}

export function rebuildEmbedIndex(dir: string, facts: readonly IndexedFact[] = libraryFacts(dir)): Promise<RebuildOutcome> {
  const path = indexPath(dir)
  const running = building.get(path)
  if (running !== undefined) return running
  const job = rebuildNow(dir, facts).finally(() => {
    building.delete(path)
  })
  building.set(path, job)
  return job
}

async function rebuildNow(dir: string, facts: readonly IndexedFact[]): Promise<RebuildOutcome> {
  const t0 = Date.now()
  const load = loadEmbedIndexEngine()
  if (load === null) return { built: false, rows: 0, ms: 0, reason: embedIndexOffNote() }
  const addon = loadEmbedAddon()
  if (addon.state !== 'ok') return { built: false, rows: 0, ms: 0, reason: addon.note }
  const prior = readEmbedIndex(dir)
  const byDigest = new Map<string, number[]>()
  if (prior !== null && prior.model === load.model && prior.dimension === load.dimension) for (const r of prior.rows) byDigest.set(r.h, r.v)
  const rows: EmbeddingIndexRow[] = []
  const todo: Array<{ key: string; text: string; h: string }> = []
  for (const fact of facts) {
    const h = textDigest(fact.text)
    const kept = byDigest.get(h)
    if (kept !== undefined) rows.push({ key: fact.key, h, v: kept })
    else todo.push({ key: fact.key, text: fact.text, h })
  }
  try {
    for (let at = 0; at < todo.length; at += BUILD_CHUNK) {
      const chunk = todo.slice(at, at + BUILD_CHUNK)
      const vectors = await addon.addon.embedBatchAsync(load.handle, chunk.map(c => c.text), false)
      chunk.forEach((c, i) => rows.push({ key: c.key, h: c.h, v: roundVector(vectors[i] ?? []) }))
      touchEngine()
    }
  } catch (error) {
    return { built: false, rows: 0, ms: Date.now() - t0, reason: `the engine refused a fact: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (rows.some(r => r.v.length !== load.dimension)) return { built: false, rows: 0, ms: Date.now() - t0, reason: 'the engine answered a vector of the wrong size' }
  rows.sort((a, b) => a.key.localeCompare(b.key))
  const file: EmbeddingIndexFile = { version: INDEX_VERSION, model: load.model, dimension: load.dimension, rows }
  try {
    publishLibraryFile(indexPath(dir), JSON.stringify(file))
  } catch (error) {
    return { built: false, rows: 0, ms: Date.now() - t0, reason: `the index write failed: ${String(error)}` }
  }
  return { built: true, rows: rows.length, ms: Date.now() - t0, reason: todo.length > 0 ? `embedded ${todo.length} fact(s), kept ${rows.length - todo.length}` : `kept ${rows.length} fact(s)` }
}

export interface EnsureOutcome extends RebuildOutcome {
  reused: boolean
}

export async function ensureEmbedIndex(dir: string, facts?: readonly IndexedFact[]): Promise<EnsureOutcome> {
  const resolved = facts ?? libraryFacts(dir)
  const index = readEmbedIndex(dir)
  const freshness = embedIndexFreshness(index, resolved)
  if (freshness.current) return { built: false, reused: true, rows: index!.rows.length, ms: 0, reason: 'current' }
  const outcome = await rebuildEmbedIndex(dir, resolved)
  return { ...outcome, reused: false }
}

export async function appendFactToEmbedIndex(dir: string, fact: IndexedFact): Promise<boolean> {
  const index = readEmbedIndex(dir)
  if (index === null) return false
  const load = loadEmbedIndexEngine()
  const addon = loadEmbedAddon()
  if (load === null || addon.state !== 'ok' || index.model !== load.model) return false
  try {
    const [vector] = await addon.addon.embedBatchAsync(load.handle, [fact.text], false)
    const v = roundVector(vector ?? [])
    if (v.length !== index.dimension) return false
    const current = readEmbedIndex(dir) ?? index
    const rows = current.rows.filter(r => r.key !== fact.key)
    rows.push({ key: fact.key, h: textDigest(fact.text), v })
    rows.sort((a, b) => a.key.localeCompare(b.key))
    publishLibraryFile(indexPath(dir), JSON.stringify({ version: INDEX_VERSION, model: current.model, dimension: current.dimension, rows }))
    return true
  } catch {
    return false
  }
}

export function recallRankingWords(dir: string = mnemeLibraryDir()): string {
  const ready = describeSemanticReadiness()
  if (ready.state === 'word-only') return WORD_MATCH_ONLY_WORDS
  if (ready.road === 'ollama') return `semantic + word match (ollama:${ready.model})`
  if (embedIndexBuilding(dir)) return `${WORD_MATCH_ONLY_WORDS} (${INDEX_BUILDING_WORDS})`
  return `semantic + word match (${ready.model})`
}

export function indexInfoLine(dir: string, facts: readonly IndexedFact[] = libraryFacts(dir)): string {
  if (embedIndexBuilding(dir)) return INDEX_BUILDING_WORDS
  const index = readEmbedIndex(dir)
  const freshness = embedIndexFreshness(index, facts)
  if (index === null || !freshness.current) return `index ${freshness.reason}`
  return `index current · ${index.rows.length} fact(s) · ${index.model}`
}

export function indexFileExists(dir: string): boolean {
  try {
    return statSync(indexPath(dir)).isFile()
  } catch {
    return false
  }
}
