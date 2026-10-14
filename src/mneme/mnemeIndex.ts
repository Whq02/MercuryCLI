import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { loadEmbedAddon } from './embedPack.js'
import { checkEmbedModel, embedDefaultModel, resolveEmbedModelPin } from './embedModels.js'
import { listArchiveDocs, listTopicDocs, publishLibraryFile } from './mnemeLibrary.js'
import type { MnemeEntry, MnemeTopicDoc } from './mnemeTopicDocs.js'

export const INDEX_DIR = '.index'
export const INDEX_FILE = 'embeddings.json'
const VECTOR_DECIMALS = 5

export interface EmbeddingIndexRow {
  seq: number
  h: string
  v: number[]
}

export interface EmbeddingIndexFile {
  version: 1
  model: string
  dimension: number
  rows: EmbeddingIndexRow[]
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

export function resetEmbedIndexForTest(): void {
  engine = null
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
  if (engine !== null) return engine
  const addon = loadEmbedAddon()
  if (addon.state !== 'ok') return null
  const check = checkEmbedModel(resolveEmbedModelPin())
  if (check.state !== 'present') return null
  try {
    const handle = addon.addon.loadModel(check.path)
    const info = addon.addon.modelInfo(handle)
    engine = { handle, model: check.name, dimension: info.dimension }
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
  seq: number
  sim: number
}

export function searchEmbedIndex(query: string, index: EmbeddingIndexFile, engineStatus: { state: 'ok'; model: string; dimension: number } | { state: 'off'; note: string }, limit = 8): EmbedSearchRow[] {
  const load = loadEmbedIndexEngine()
  if (load === null || engineStatus.state !== 'ok' || index.model !== load.model || index.dimension !== load.dimension) return []
  let q: number[]
  try {
    q = roundVector(loadEmbedAddon().state === 'ok' ? (loadEmbedAddon() as { state: 'ok'; addon: { embed(handle: number, text: string, isQuery?: boolean): number[] } }).addon.embed(load.handle, query, true) : [])
  } catch {
    return []
  }
  if (q.length !== index.dimension) return []
  const out: EmbedSearchRow[] = []
  for (const row of index.rows) {
    if (row.v.length !== index.dimension) continue
    out.push({ seq: row.seq, sim: cosine(q, row.v) })
  }
  out.sort((a, b) => b.sim - a.sim || a.seq - b.seq)
  return out.slice(0, limit)
}

function indexStampOf(docs: readonly MnemeTopicDoc[]): string {
  const h = createHash('sha256')
  for (const doc of docs) {
    h.update(doc.slug)
    for (const s of doc.sections) for (const e of s.entries) h.update(`${e.seq}\n${e.text}\n`)
  }
  return h.digest('hex')
}

function decodeIndexFile(raw: unknown): EmbeddingIndexFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as Partial<EmbeddingIndexFile> & { rows?: unknown }
  const dimension = f.dimension
  if (f.version !== 1 || typeof f.model !== 'string' || typeof dimension !== 'number' || !Number.isInteger(dimension) || dimension <= 0 || !Array.isArray(f.rows)) return null
  const rows: EmbeddingIndexRow[] = []
  const seen = new Set<number>()
  for (const row of f.rows) {
    if (typeof row !== 'object' || row === null) return null
    const r = row as Partial<EmbeddingIndexRow> & { v?: unknown }
    const seq = r.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0 || typeof r.h !== 'string' || !/^[0-9a-f]{16}$/.test(r.h) || !Array.isArray(r.v) || r.v.length !== dimension || !r.v.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) return null
    if (seen.has(seq)) return null
    seen.add(seq)
    rows.push({ seq, h: r.h, v: r.v as number[] })
  }
  return { version: 1, model: f.model, dimension, rows }
}

export function readEmbedIndex(dir: string): EmbeddingIndexFile | null {
  try {
    return decodeIndexFile(JSON.parse(readFileSync(indexPath(dir), 'utf8')))
  } catch {
    return null
  }
}

export interface IndexFreshness {
  current: boolean
  reason: string
  stamp: string
  rows: number
}

function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function embedIndexFreshness(index: EmbeddingIndexFile | null, docs: readonly MnemeTopicDoc[]): IndexFreshness {
  const stamp = indexStampOf(docs)
  const live = new Map<number, string>()
  for (const d of docs) for (const s of d.sections) for (const e of s.entries) live.set(e.seq, textDigest(e.text))
  if (index === null) return { current: false, reason: 'absent', stamp, rows: 0 }
  if (index.model !== indexModelName()) return { current: false, reason: `built for ${index.model}, the pin now serves ${indexModelName()}`, stamp, rows: index.rows.length }
  const indexed = new Map(index.rows.map(r => [r.seq, r.h]))
  const missing = [...live.keys()].filter(seq => !indexed.has(seq)).length
  const extra = [...indexed.keys()].filter(seq => !live.has(seq)).length
  const changed = [...live.entries()].filter(([seq, h]) => indexed.get(seq) !== undefined && indexed.get(seq) !== h).length
  if (missing > 0 || extra > 0 || changed > 0) return { current: false, reason: `${missing} fact(s) unindexed, ${extra} indexed seq(s) no longer live, ${changed} reworded`, stamp, rows: index.rows.length }
  return { current: true, reason: 'current', stamp, rows: index.rows.length }
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

export function rebuildEmbedIndex(dir: string, docs: readonly MnemeTopicDoc[] = libraryDocs(dir)): RebuildOutcome {
  const t0 = Date.now()
  const load = loadEmbedIndexEngine()
  if (load === null) return { built: false, rows: 0, ms: 0, reason: embedIndexOffNote() }
  const addon = loadEmbedAddon()
  if (addon.state !== 'ok') return { built: false, rows: 0, ms: 0, reason: addon.note }
  const entries: Array<{ seq: number; text: string }> = []
  for (const doc of docs) for (const s of doc.sections) for (const e of s.entries) entries.push({ seq: e.seq, text: e.text })
  const prior = readEmbedIndex(dir)
  const reusable = prior !== null && prior.model === load.model && prior.dimension === load.dimension
    ? new Map(prior.rows.map(r => [r.seq, r]))
    : new Map<number, EmbeddingIndexRow>()
  const rows: EmbeddingIndexRow[] = []
  let embedded = 0
  try {
    for (const entry of entries) {
      const kept = reusable.get(entry.seq)
      const digest = textDigest(entry.text)
      if (kept !== undefined && kept.h === digest) {
        rows.push({ seq: entry.seq, h: kept.h, v: kept.v })
        continue
      }
      rows.push({ seq: entry.seq, h: digest, v: roundVector(addon.addon.embed(load.handle, entry.text, false)) })
      embedded++
    }
  } catch (error) {
    return { built: false, rows: 0, ms: Date.now() - t0, reason: `the engine refused a fact: ${error instanceof Error ? error.message : String(error)}` }
  }
  rows.sort((a, b) => a.seq - b.seq)
  const file: EmbeddingIndexFile = { version: 1, model: load.model, dimension: load.dimension, rows }
  try {
    publishLibraryFile(indexPath(dir), JSON.stringify(file))
  } catch (error) {
    return { built: false, rows: 0, ms: Date.now() - t0, reason: `the index write failed: ${String(error)}` }
  }
  return { built: true, rows: rows.length, ms: Date.now() - t0, reason: embedded > 0 ? `embedded ${embedded} fact(s), kept ${rows.length - embedded}` : `kept ${rows.length} fact(s)` }
}

function libraryDocs(dir: string): MnemeTopicDoc[] {
  return [...listTopicDocs(dir), ...listArchiveDocs(dir)]
}

export interface EnsureOutcome extends RebuildOutcome {
  reused: boolean
}

export function ensureEmbedIndex(dir: string, docs?: readonly MnemeTopicDoc[]): EnsureOutcome {
  const resolved = docs ?? libraryDocs(dir)
  const index = readEmbedIndex(dir)
  const freshness = embedIndexFreshness(index, resolved)
  if (freshness.current) return { built: false, reused: true, rows: index!.rows.length, ms: 0, reason: 'current' }
  const outcome = rebuildEmbedIndex(dir, resolved)
  return { ...outcome, reused: false }
}

export function appendFactToEmbedIndex(dir: string, entry: Pick<MnemeEntry, 'seq' | 'text'>): boolean {
  const index = readEmbedIndex(dir)
  if (index === null) return false
  const load = loadEmbedIndexEngine()
  const addon = loadEmbedAddon()
  if (load === null || addon.state !== 'ok' || index.model !== load.model) return false
  try {
    const v = roundVector(addon.addon.embed(load.handle, entry.text, false))
    if (v.length !== index.dimension) return false
    const rows = index.rows.filter(r => r.seq !== entry.seq)
    rows.push({ seq: entry.seq, h: textDigest(entry.text), v })
    rows.sort((a, b) => a.seq - b.seq)
    publishLibraryFile(indexPath(dir), JSON.stringify({ version: 1, model: index.model, dimension: index.dimension, rows }))
    return true
  } catch {
    return false
  }
}

export function indexInfoLine(dir: string, docs: readonly MnemeTopicDoc[]): string {
  const index = readEmbedIndex(dir)
  const freshness = embedIndexFreshness(index, docs)
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

export function embedIndexQueryCostHint(facts: number): string {
  return `${facts} fact(s) indexed`
}
