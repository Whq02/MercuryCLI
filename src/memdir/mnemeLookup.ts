import { join } from 'node:path'
import { currentBufferPath, pendingRows } from './mnemeBuffer.js'
import { readPinnedStatus } from './mnemeFrontPage.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { listTopicDocs } from './mnemeLibrary.js'
import { docFileName, serializeSignature, type MnemeEntry } from './mnemeTopicDocs.js'
import { bumpUsage, readUsage, usageOf } from './mnemeUsage.js'

export const LOOKUP_LIMIT = 5
const MAX_QUERY_TOKENS = 16

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

export function lookupTokens(raw: string): string[] {
  const out: string[] = []
  for (const token of raw.toLowerCase().split(/[^a-z0-9_.\-/]+/)) {
    const t = token.replace(/^[._\-/]+|[._\-/]+$/g, '')
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= MAX_QUERY_TOKENS) break
  }
  return out
}

function escapeRegExp(s: string): string {
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
}

export interface LookupHit extends LookupCandidate {
  score: number
  matched: string[]
}

export function candidates(dir: string): LookupCandidate[] {
  const out: LookupCandidate[] = []
  for (const doc of listTopicDocs(dir)) {
    const pagePath = join(dir, docFileName(doc.slug))
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        out.push({ id: `seq:${entry.seq}`, text: entry.text, signature: serializeSignature(entry), slug: doc.slug, pagePath, seq: entry.seq, pending: false })
      }
    }
  }
  const bufferPath = currentBufferPath(dir)
  for (const row of pendingRows(dir)) {
    out.push({ id: `pending:${row.ts}`, text: row.text, signature: `[unconsolidated, ${row.ts}, ${row.source}]`, slug: row.topicHint ?? 'general', pagePath: bufferPath, pending: true })
  }
  return out
}

export function rankCandidates(
  query: string,
  pool: readonly LookupCandidate[],
  opts: { exclude?: ReadonlySet<string>; limit?: number; usage?: Record<string, { last: string; count: number }> } = {},
): LookupHit[] {
  const tokens = lookupTokens(query)
  if (tokens.length === 0 || pool.length === 0) return []
  const limit = Math.min(Math.max(opts.limit ?? LOOKUP_LIMIT, 1), 20)
  const exclude = opts.exclude ?? new Set<string>()
  const usage = opts.usage ?? {}
  const matchers = tokens.map(t => ({ token: t, re: new RegExp(`(^|[^a-z0-9])${escapeRegExp(t)}`) }))
  const lowered = pool.map(c => c.text.toLowerCase())
  const df = new Map<string, number>()
  for (const m of matchers) {
    let n = 0
    for (const text of lowered) if (m.re.test(text)) n++
    df.set(m.token, n)
  }
  const total = pool.length
  const averageLength = lowered.reduce((n, t) => n + t.length, 0) / total || 1
  const hits: LookupHit[] = []
  pool.forEach((candidate, i) => {
    if (exclude.has(candidate.id)) return
    let score = 0
    const matched: string[] = []
    let discriminating = false
    for (const m of matchers) {
      if (!m.re.test(lowered[i]!)) continue
      const n = df.get(m.token) ?? 0
      if (n === 0) continue
      matched.push(m.token)
      score += 1 + Math.log((total + 1) / n)
      if (n < total || total === 1) discriminating = true
    }
    if (matched.length === 0 || !discriminating) return
    score /= 0.5 + 0.5 * (lowered[i]!.length / averageLength)
    hits.push({ ...candidate, score, matched })
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
