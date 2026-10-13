import { join } from 'node:path'
import { currentBufferPath, pendingRows } from './mnemeBuffer.js'
import { readPinnedStatus } from './mnemeFrontPage.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { listTopicDocs } from './mnemeLibrary.js'
import { docFileName, serializeSignature } from './mnemeTopicDocs.js'
import { stemLookupToken } from './mnemeStemmer.js'
import { bumpUsage, readPins, readUsage, usageOf } from './mnemeUsage.js'

export const LOOKUP_LIMIT = 5
const MAX_QUERY_TOKENS = 16
export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const RECENCY_TAU_MS = 90 * 24 * 60 * 60 * 1000

function recencyOf(candidate: LookupCandidate, now: number): number {
  const observed = Date.parse(candidate.time ?? '')
  if (candidate.pinned || !Number.isFinite(observed) || !Number.isFinite(now)) return 1
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
}

export interface LookupHit extends LookupCandidate {
  score: number
  matched: string[]
}

export function candidates(dir: string): LookupCandidate[] {
  const out: LookupCandidate[] = []
  const pins = new Set(readPins(dir).map(pin => pin.seq))
  for (const doc of listTopicDocs(dir)) {
    const pagePath = join(dir, docFileName(doc.slug))
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        out.push({ id: `seq:${entry.seq}`, text: entry.text, signature: serializeSignature(entry), slug: doc.slug, pagePath, seq: entry.seq, pending: false, time: entry.time, pinned: pins.has(entry.seq) })
      }
    }
  }
  const bufferPath = currentBufferPath(dir)
  for (const row of pendingRows(dir)) {
    out.push({ id: `pending:${row.ts}`, text: row.text, signature: `[unconsolidated, ${row.ts}, ${row.source}]`, slug: row.topicHint ?? 'general', pagePath: bufferPath, pending: true, time: row.ts })
  }
  return out
}

export function rankCandidates(
  query: string,
  pool: readonly LookupCandidate[],
  opts: { exclude?: ReadonlySet<string>; limit?: number; usage?: Record<string, { last: string; count: number }>; now?: number } = {},
): LookupHit[] {
  const tokens = lookupTokens(query)
  if (tokens.length === 0 || pool.length === 0) return []
  const limit = Math.min(Math.max(opts.limit ?? LOOKUP_LIMIT, 1), 20)
  const exclude = opts.exclude ?? new Set<string>()
  const usage = opts.usage ?? {}
  const now = opts.now ?? Date.now()
  const documents = pool.map(candidate => {
    const terms = lookupTerms(candidate.text)
    const frequencies = new Map<string, number>()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    return { length: terms.length, frequencies }
  })
  const df = new Map(tokens.map(token => [token, documents.filter(doc => doc.frequencies.has(token)).length]))
  const total = pool.length
  const averageLength = documents.reduce((n, doc) => n + doc.length, 0) / total || 1
  const hits: LookupHit[] = []
  pool.forEach((candidate, i) => {
    if (exclude.has(candidate.id)) return
    const doc = documents[i]!
    let score = 0
    const matched: string[] = []
    let discriminating = false
    for (const token of tokens) {
      const frequency = doc.frequencies.get(token) ?? 0
      if (frequency === 0) continue
      const n = df.get(token)!
      matched.push(token)
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5))
      score += idf * frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / averageLength))
      if (n < total || total === 1) discriminating = true
    }
    if (matched.length === 0 || !discriminating) return
    score *= recencyOf(candidate, now)
    const { time, pinned, ...hit } = candidate
    hits.push({ ...hit, score, matched })
  })
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ua = a.seq !== undefined ? usageOf(a.seq, usage).count : 0
    const ub = b.seq !== undefined ? usageOf(b.seq, usage).count : 0
    if (ub !== ua) return ub - ua
    return (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER)
  })
  return hits.slice(0, limit)
}

export function lookupFacts(
  query: string,
  opts: { dir?: string; exclude?: ReadonlySet<string>; limit?: number; markUsed?: boolean } = {},
): LookupHit[] {
  if (!mnemeEnabled()) return []
  const dir = opts.dir ?? mnemeLibraryDir()
  const loadedPins = new Set((readPinnedStatus(dir)?.loaded ?? []).map(seq => `seq:${seq}`))
  const exclude = new Set<string>([...(opts.exclude ?? []), ...loadedPins])
  const hits = rankCandidates(query, candidates(dir), { exclude, limit: opts.limit, usage: readUsage(dir) })
  if (opts.markUsed !== false) bumpUsage(hits.map(h => h.seq).filter((s): s is number => s !== undefined), dir)
  return hits
}
