import { join } from 'node:path'
import { currentBufferPath, pendingRows } from './mnemeBuffer.js'
import { readPinnedStatus } from './mnemeFrontPage.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { listTopicDocs } from './mnemeLibrary.js'
import { docFileName, serializeSignature } from './mnemeTopicDocs.js'
import { stemLookupToken } from './mnemeStemmer.js'
import { readPins, readUsage, usageOf, type UsageRecord } from './mnemeUsage.js'
import { noteMemoryOffered, noteMemoryScores } from './mnemeSignal.js'
import { fuseSignalRanking } from './mnemeSignalRanking.js'
import { embedIndexEngineStatus, readEmbedIndex, searchEmbedIndex } from './mnemeIndex.js'

export const LOOKUP_LIMIT = 5
const MAX_QUERY_TOKENS = 16
const SEMANTIC_POOL = 16
const SEMANTIC_FUSE_K = 60
const SEMANTIC_MIN_SIM = 0.45

export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const RECENCY_TAU_MS = 90 * 24 * 60 * 60 * 1000

function recencyOf(candidate: LookupCandidate, now: number): number {
  const observed = Date.parse(candidate.time ?? '')
  if (candidate.pinned || candidate.kind === 'ruling' || !Number.isFinite(observed) || !Number.isFinite(now)) return 1
  return Math.exp(-Math.max(0, now - observed) / RECENCY_TAU_MS)
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'his',
  'how', 'its', 'let', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'get', 'got', 'him', 'she', 'too', 'use',
  'that', 'with', 'this', 'from', 'they', 'what', 'when', 'your', 'have', 'will', 'been', 'into', 'then', 'than', 'them', 'were',
  'some', 'would', 'there', 'their', 'about', 'which', 'could', 'other', 'these', 'those', 'should', 'after', 'before', 'where',
  'while', 'does', 'make', 'made', 'just', 'like', 'also', 'only', 'over', 'such', 'very', 'want', 'need', 'please', 'thanks',
  'here', 'know', 'think', 'thing', 'things', 'something', 'anything', 'first', 'last', 'next', 'more', 'most', 'much', 'many',
  'each', 'every', 'both', 'same', 'still', 'again', 'back', 'well', 'help', 'tell', 'show', 'look', 'give', 'take', 'come', 'went',
  'going', 'doing', 'done', 'okay', 'yes', 'why', 'say', 'said', 'run', 'file', 'files', 'code', 'work', 'working',
])

export function lookupTerms(raw: string): string[] {
  const out: string[] = []
  for (const token of raw.toLowerCase().split(/[^a-z0-9_.\-/]+/)) {
    const t = token.replace(/^[._\-/]+|[._\-/]+$/g, '')
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue
    const stem = stemLookupToken(t)
    if (stem.length >= 3 && !STOPWORDS.has(stem)) out.push(stem)
  }
  return out
}

export function lookupTokens(raw: string): string[] {
  return [...new Set(lookupTerms(raw))].slice(0, MAX_QUERY_TOKENS)
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type LookupKind = 'fact' | 'ruling' | 'pending' | 'handoff' | 'session'

export interface LookupCandidate {
  id: string
  text: string
  signature: string
  slug: string
  pagePath: string
  seq?: number
  pending: boolean
  time?: string
  pinned?: boolean
  kind?: LookupKind
  useCount?: number
}

export interface LookupHit extends Omit<LookupCandidate, 'time' | 'pinned' | 'kind' | 'useCount'> {
  score: number
  matched: string[]
}

export interface CandidateFeatures {
  bm25: number
  recency: number
  pinned: boolean
  kind: LookupKind
  useCount: number
  discriminating: boolean
}

export interface ScoredCandidate extends LookupCandidate {
  score: number
  matched: string[]
  features: CandidateFeatures
}

export interface RankingOptions {
  dir?: string
  exclude?: ReadonlySet<string>
  usage?: Record<string, UsageRecord>
  now?: number
}

export function candidates(dir: string): LookupCandidate[] {
  const out: LookupCandidate[] = []
  const pins = new Set(readPins(dir).map(pin => pin.seq))
  const usage = readUsage(dir)
  for (const doc of listTopicDocs(dir)) {
    const pagePath = join(dir, docFileName(doc.slug))
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        out.push({ id: `seq:${entry.seq}`, text: entry.text, signature: serializeSignature(entry), slug: doc.slug, pagePath, seq: entry.seq, pending: false, time: entry.time, pinned: pins.has(entry.seq), kind: pins.has(entry.seq) ? 'ruling' : 'fact', useCount: usageOf(entry.seq, usage).count })
      }
    }
  }
  const bufferPath = currentBufferPath(dir)
  for (const row of pendingRows(dir)) {
    out.push({ id: `pending:${row.ts}`, text: row.text, signature: `[unconsolidated, ${row.ts}, ${row.source}]`, slug: row.topicHint ?? 'general', pagePath: bufferPath, pending: true, time: row.ts, pinned: false, kind: 'pending', useCount: 0 })
  }
  return out
}

export function fuseRankings(rankings: Array<Array<string>>, k = 60): string[] {
  if (!Number.isFinite(k) || k < 0) throw new RangeError('rank fusion k must be finite and nonnegative')
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    const unique = [...new Set(ranking)]
    unique.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!)
}

export function scoreCandidates(query: string, pool: readonly LookupCandidate[], now: number = Date.now()): ScoredCandidate[] {
  const tokens = lookupTokens(query)
  const documents = pool.map(candidate => {
    const terms = lookupTerms(candidate.text)
    const frequencies = new Map<string, number>()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    return { length: terms.length, frequencies }
  })
  const df = new Map(tokens.map(token => [token, documents.filter(doc => doc.frequencies.has(token)).length]))
  const total = pool.length
  const averageLength = documents.reduce((n, doc) => n + doc.length, 0) / total || 1
  return pool.map((candidate, i) => {
    const doc = documents[i]!
    let bm25 = 0
    const matched: string[] = []
    let discriminating = false
    for (const token of tokens) {
      const frequency = doc.frequencies.get(token) ?? 0
      if (frequency === 0) continue
      const n = df.get(token)!
      matched.push(token)
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5))
      bm25 += idf * frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / averageLength))
      if (n < total || total === 1) discriminating = true
    }
    const pinned = candidate.pinned === true || candidate.kind === 'ruling'
    const recency = recencyOf(candidate, now)
    const kind = candidate.kind ?? (pinned ? 'ruling' : candidate.pending ? 'pending' : 'fact')
    const useCount = Number.isFinite(candidate.useCount) ? Math.max(0, candidate.useCount!) : 0
    return { ...candidate, score: discriminating ? bm25 * recency : 0, matched, features: { bm25, recency, pinned, kind, useCount, discriminating } }
  })
}

function scoredForRanking(query: string, pool: readonly LookupCandidate[], opts: RankingOptions): ScoredCandidate[] {
  const scoredPool = opts.usage ? pool.map(candidate => ({ ...candidate, useCount: candidate.seq !== undefined ? usageOf(candidate.seq, opts.usage!).count : candidate.useCount })) : pool
  const scored = scoreCandidates(query, scoredPool, opts.now).filter(hit => !opts.exclude?.has(hit.id))
  noteMemoryScores(query, scored, opts.dir)
  return scored
}

export function fuseRecallRankings(query: string, pool: readonly LookupCandidate[], grepIds: readonly string[], opts: RankingOptions = {}): string[] {
  const scored = scoredForRanking(query, pool, opts)
  const lexical = scored.filter(hit => hit.features.discriminating)
    .sort((a, b) => b.score - a.score || b.features.useCount - a.features.useCount || (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER))
  const grep = [...new Set(grepIds)].filter(id => !opts.exclude?.has(id))
  const base = fuseSignalRanking([grep, lexical.map(hit => hit.id)], scored, opts.dir ?? mnemeLibraryDir(), fuseRankings)
  const semantic = semanticRanking(query, pool, opts.dir ?? mnemeLibraryDir())
  if (semantic.length === 0) return base
  const inBase = new Set(base)
  const semanticOnly = semantic.filter(id => !inBase.has(id))
  const merged = [...base]
  for (const id of semanticOnly) {
    const anchor = semantic.find(s => inBase.has(s) && merged.includes(s))
    if (anchor === undefined) {
      merged.push(id)
      continue
    }
    merged.splice(merged.indexOf(anchor) + 1, 0, id)
  }
  const rankOf = new Map(merged.map((id, index) => [id, index]))
  return [...merged].sort((a, b) => (rankOf.get(a) ?? merged.length) - (rankOf.get(b) ?? merged.length))
}

export function semanticRanking(query: string, pool: readonly LookupCandidate[], dir: string): string[] {
  const bySeq = new Map<number, string>()
  for (const candidate of pool) if (candidate.seq !== undefined) bySeq.set(candidate.seq, candidate.id)
  const index = readEmbedIndex(dir)
  if (index === null) return []
  const hits = searchEmbedIndex(query, index, embedIndexEngineStatus(), SEMANTIC_POOL)
  if (hits.length === 0) return []
  const mean = hits.reduce((s, x) => s + x.sim, 0) / hits.length
  const std = Math.sqrt(hits.reduce((s, x) => s + (x.sim - mean) ** 2, 0) / hits.length) || 1
  const floor = mean + 0.5 * std
  const top = hits[0]!.sim
  if (top < SEMANTIC_MIN_SIM) return []
  const out: string[] = []
  for (const hit of hits) {
    if (hit.sim < floor) break
    if (out.length >= LOOKUP_LIMIT + 4) break
    const id = bySeq.get(hit.seq)
    if (id !== undefined) out.push(id)
  }
  return out
}

export function rankAllCandidates(query: string, pool: readonly LookupCandidate[], opts: RankingOptions = {}): LookupHit[] {
  const hits = scoredForRanking(query, pool, opts).filter(hit => hit.features.discriminating)
  const dir = opts.dir ?? mnemeLibraryDir()
  hits.sort((a, b) => b.score - a.score || (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER))
  const byUse = [...hits].sort((a, b) => b.features.useCount - a.features.useCount)
  const byId = new Map(hits.map(hit => [hit.id, hit]))
  return fuseSignalRanking([hits.map(hit => hit.id), byUse.map(hit => hit.id)], hits, dir, fuseRankings).map(id => {
    const { time, pinned, kind, useCount, features, ...hit } = byId.get(id)!
    return hit
  })
}

export function rankCandidates(query: string, pool: readonly LookupCandidate[], opts: RankingOptions & { limit?: number } = {}): LookupHit[] {
  const limit = Math.min(Math.max(opts.limit ?? LOOKUP_LIMIT, 1), 20)
  return rankAllCandidates(query, pool, opts).slice(0, limit)
}

export function lookupFacts(
  query: string,
  opts: { dir?: string; exclude?: ReadonlySet<string>; limit?: number } = {},
): LookupHit[] {
  if (!mnemeEnabled()) return []
  const dir = opts.dir ?? mnemeLibraryDir()
  const loadedPins = new Set((readPinnedStatus(dir)?.loaded ?? []).map(seq => `seq:${seq}`))
  const exclude = new Set<string>([...(opts.exclude ?? []), ...loadedPins])
  const hits = rankCandidates(query, candidates(dir), { dir, exclude, limit: opts.limit })
  noteMemoryOffered(query, hits, dir)
  return hits
}
