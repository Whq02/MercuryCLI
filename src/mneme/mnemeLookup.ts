import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
import { escapeRegExp } from '../utils/stringUtils.js'

const LOOKUP_LIMIT = 5
const MAX_QUERY_TOKENS = 16
const SEMANTIC_POOL = 16
const SEMANTIC_MIN_SIM = 0.45
const SEMANTIC_TIE_WIDTH = 0.02

const BM25_K1 = 1.2
const BM25_B = 0.75
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

type LookupKind = 'fact' | 'ruling' | 'pending' | 'handoff' | 'session'

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

interface LookupHit extends Omit<LookupCandidate, 'time' | 'pinned' | 'kind' | 'useCount'> {
  score: number
  matched: string[]
}

interface CandidateFeatures {
  bm25: number
  recency: number
  pinned: boolean
  kind: LookupKind
  useCount: number
  discriminating: boolean
  discriminatingStems: number
  rareStems: number
  maxIdf: number
}

interface ScoredCandidate extends LookupCandidate {
  score: number
  matched: string[]
  features: CandidateFeatures
}

interface RankingOptions {
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
    let discriminatingStems = 0
    let rareStems = 0
    let maxIdf = 0
    for (const token of tokens) {
      const frequency = doc.frequencies.get(token) ?? 0
      if (frequency === 0) continue
      const n = df.get(token)!
      matched.push(token)
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5))
      if (idf >= 1.5 || n === 1) discriminatingStems++
      if (idf >= RARE_STEM_IDF || n === 1) rareStems++
      maxIdf = Math.max(maxIdf, idf)
      bm25 += idf * frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / averageLength))
      if (n < total || total === 1) discriminating = true
    }
    const pinned = candidate.pinned === true || candidate.kind === 'ruling'
    const recency = recencyOf(candidate, now)
    const kind = candidate.kind ?? (pinned ? 'ruling' : candidate.pending ? 'pending' : 'fact')
    const useCount = Number.isFinite(candidate.useCount) ? Math.max(0, candidate.useCount!) : 0
    return { ...candidate, score: discriminating ? bm25 * recency : 0, matched, features: { bm25, recency, pinned, kind, useCount, discriminating, discriminatingStems, rareStems, maxIdf } }
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
  const dir = opts.dir ?? mnemeLibraryDir()
  const scores = new Map<string, number>()
  const semantic = semanticHits(query, pool, dir, scores).filter(hit => !opts.exclude?.has(hit.id))
  const extra = semantic.length > 0 ? [{ order: semantic.map(hit => hit.id), tieKey: semanticTieKey(semantic) }] : []
  return fuseSignalRanking([grep, lexical.map(hit => hit.id)], scored, dir, fuseRankings, extra, order =>
    scores.size === 0 ? order : [...order.slice(0, LOOKUP_LIMIT).sort((a, b) => (scores.get(b) ?? -1) - (scores.get(a) ?? -1)), ...order.slice(LOOKUP_LIMIT)])
}

interface SemanticHit {
  id: string
  sim: number
}

function semanticHits(query: string, pool: readonly LookupCandidate[], dir: string, scores?: Map<string, number>): SemanticHit[] {
  const byKey = new Map<string, string>()
  for (const candidate of pool) byKey.set(candidate.seq !== undefined ? `seq:${candidate.seq}` : candidate.id, candidate.id)
  const index = readEmbedIndex(dir)
  if (index === null) return []
  const all = searchEmbedIndex(query, index, embedIndexEngineStatus(), scores ? Infinity : SEMANTIC_POOL)
  if (scores) for (const hit of all) {
    const id = byKey.get(hit.key)
    if (id !== undefined) scores.set(id, hit.sim)
  }
  const hits = all.slice(0, SEMANTIC_POOL)
  if (hits.length === 0) return []
  const mean = hits.reduce((s, x) => s + x.sim, 0) / hits.length
  const std = Math.sqrt(hits.reduce((s, x) => s + (x.sim - mean) ** 2, 0) / hits.length) || 1
  const floor = mean + 0.5 * std
  const top = hits[0]!.sim
  if (top < SEMANTIC_MIN_SIM) return []
  const out: SemanticHit[] = []
  for (const hit of hits) {
    if (hit.sim < floor && hit.sim < top - SEMANTIC_TIE_WIDTH) break
    if (out.length >= LOOKUP_LIMIT + 4) break
    const id = byKey.get(hit.key)
    if (id !== undefined) out.push({ id, sim: hit.sim })
  }
  return out
}

export function semanticRanking(query: string, pool: readonly LookupCandidate[], dir: string): string[] {
  return semanticHits(query, pool, dir).map(hit => hit.id)
}

function semanticTieKey(hits: readonly SemanticHit[]): (id: string) => string | null {
  const group = new Map<string, string>()
  let groupTop = Number.POSITIVE_INFINITY
  let groupIndex = -1
  for (const hit of [...hits].sort((a, b) => b.sim - a.sim)) {
    if (hit.sim < groupTop - SEMANTIC_TIE_WIDTH) {
      groupTop = hit.sim
      groupIndex++
    }
    group.set(hit.id, String(groupIndex))
  }
  return id => group.get(id) ?? null
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

interface AutomaticMemoryHit extends LookupHit {
  witness: string
  admission: 'stems' | 'rare-stem' | 'semantic' | 'constraint' | 'companion' | 'rare-tier'
  bm25: number
  cosine: number | null
  discriminatingStems: number
  maxIdf: number
  historical?: { names: number; latest: number }
}

const automaticScores = new WeakMap<object, Map<string, ReadonlyMap<string, number>>>()

function automaticSemanticScores(query: string, pool: readonly LookupCandidate[], dir: string): ReadonlyMap<string, number> {
  const index = readEmbedIndex(dir)
  if (!index) return new Map()
  const status = embedIndexEngineStatus()
  if (status.state !== 'ok' || status.model !== index.model || status.dimension !== index.dimension) return new Map()
  let queries = automaticScores.get(index)
  if (!queries) { queries = new Map(); automaticScores.set(index, queries) }
  let scores = queries.get(query)
  if (!scores) { scores = new Map(searchEmbedIndex(query, index, status, Infinity).map(row => [row.key, row.sim])); queries.set(query, scores) }
  const rows = new Map(index.rows.map(row => [row.key, row]))
  const valid = new Map<string, number>()
  for (const candidate of pool) {
    const row = rows.get(candidate.id)
    if (row?.h !== createHash('sha256').update(candidate.text).digest('hex').slice(0, 16)) continue
    const score = scores.get(candidate.id)
    if (score !== undefined) valid.set(candidate.id, score)
  }
  return valid
}

function constraintText(text: string): boolean {
  return /\b(?:always|never|must|only|rule|constraint|census|guard|do not)\b/i.test(text)
}

const WRITING_RULE = /\b(?:writing|copy|captions?|subtitles?|prose|voice|wording)\b/i
const WRITING_TASK = /\b(?:copy[- ]?edit(?:s|ing)?|captions?|subtitles?|prose|wording|posts?|replies|reply|tweets?|one[- ]liners?|taglines?|headlines?|blurbs?|linkedin)\b/i

const RULE_WORDS = /\b(?:always|never|must|only|rule|constraint|census|guard|do not|stays?|keep|no mention)\b/i

function ruleSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(sentence => sentence.trim() !== '')
}

function ruleWindows(text: string): string[] {
  return ruleSentences(text).filter(sentence => RULE_WORDS.test(sentence))
}

const PATH_ROOTS = /^(?:src|docs|scripts|assets|lib|test|tests|packages|config|ops|app|apps|tools|public|infra|data|etc|bin|build|dist|native|vendor|records|lead-scripts)\//
const PATH_SHAPE = /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|~\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+)/g

function citedPaths(sentence: string): string[] {
  const out: string[] = []
  for (const match of sentence.matchAll(PATH_SHAPE)) {
    const token = match[1]!.replace(/^(?:\.{1,2}\/|\/|~\/)/, '').replace(/[.,;:)]+$/, '')
    if (/^[\d/.-]+$/.test(token) || /^(?:https?|mercury|file):/i.test(token)) continue
    if (/\.[A-Za-z0-9]{1,8}$/.test(token) || PATH_ROOTS.test(token) || token.length >= 12) out.push(token)
  }
  return out
}

function taskConstraint(text: string, query: string, files: readonly string[]): boolean {
  if (!constraintText(text)) return false
  const observed = [query, ...files].join(' ')
  const windows = ruleWindows(text)
  if (/release[ -]notes?|releases\/|changelog/i.test(observed) && windows.some(window => /\brelease[ -]notes?\b|\bchangelog\b/i.test(window))) return true
  if (WRITING_TASK.test(query) && windows.some(window => WRITING_RULE.test(window))) return true
  return ruleSentences(text).some(sentence => {
    const clauses = sentence.split(/\s*[;:]\s*/)
    return clauses.some((clause, index) => (RULE_WORDS.test(clause) || RULE_WORDS.test(clauses[index + 1] ?? '')) && citedPaths(clause).some(path => {
      const matcher = new RegExp(`(?:^|/)${escapeRegExp(path).replace(/\\\*/g, '[^/]*')}$`)
      return files.some(file => matcher.test(file)) || query.includes(path)
    }))
  })
}

const LOG_HEAD = /^(?:session note\b|\d{4}-\d{2}-\d{2}|(?:1\.0\.0-)?beta[. -]?\d+\b|state of\b|[\w-]+ lane \([^)]*\), \d{4}-\d{2}-\d{2}\b)|\b(?:states? (?:on|at)\b|shipped\b|launched\b|lanes? [^:]{0,60}\blanded\b|(?:learned|agreed|clarified|corrected) \d{4}-|prep, state\b|facts learned\b)/i

function logNote(text: string): boolean {
  const head = text.split(':')[0]!.slice(0, 100)
  return LOG_HEAD.test(head)
}

const COMPANION_IDF = 2.2
const STEM_BONUS = 0.05
const SEMANTIC_FLOOR = 0.62
const RARE_STEM_IDF = 2.2
const RARE_STEM_BM25 = 5
const STEM_RARE_MIN = 1

function cycleNamed(text: string): number {
  let latest = 0
  for (const match of text.matchAll(/\b(?:1\.0\.0-)?beta[. -]?(\d+)\b/gi)) latest = Math.max(latest, Number(match[1]))
  return latest
}

const PLAN_WORDS = /\b(?:next steps?|backlog|queue|what follows|after\b.{0,40}\bships?|this cycle|then the (?:work|owner|lead))\b/i

function companionsOf(constraint: LookupCandidate, pool: readonly LookupCandidate[], taken: ReadonlySet<string>, now: number | undefined): LookupCandidate[] {
  const terms = pool.map(candidate => new Set(lookupTerms(candidate.text)))
  const total = pool.length
  const rareTerm = (token: string): boolean => {
    if (/\d/.test(token)) return false
    const n = terms.filter(set => set.has(token)).length
    return Math.log(1 + (total - n + 0.5) / (n + 0.5)) >= COMPANION_IDF
  }
  const out: LookupCandidate[] = []
  for (const hit of scoreCandidates(constraint.text, pool, now)) {
    if (hit.id === constraint.id || taken.has(hit.id) || /^retired: /.test(hit.text) || (!hit.pinned && logNote(hit.text))) continue
    if (hit.matched.filter(rareTerm).length >= 2) out.push(hit)
  }
  return out
}

export function automaticMemoryCandidates(query: string, opts: { dir?: string; pool?: readonly LookupCandidate[]; files?: readonly string[]; now?: number; limit?: number; semantic?: boolean; rareTier?: boolean } = {}): AutomaticMemoryHit[] {
  const dir = opts.dir ?? mnemeLibraryDir()
  const pool = opts.pool ?? candidates(dir)
  const semantic = opts.semantic === false ? new Map<string, number>() : automaticSemanticScores(query, pool, dir)
  const admitted: AutomaticMemoryHit[] = []
  const cycle = /\bbeta[. -]?(\d+)\b/i.exec([query, ...(opts.files ?? [])].join(' '))?.[1]
  const latest = Math.max(0, ...pool.map(candidate => cycleNamed(candidate.text)))
  const witnessOf = (id: string, text: string): string => createHash('sha256').update(`${dir}\0${id}\0${text}`).digest('hex')
  const historicalOf = (candidate: LookupCandidate): { names: number; latest: number } | undefined => {
    const names = cycleNamed(candidate.text)
    return !candidate.pinned && names > 0 && names < latest && (PLAN_WORDS.test(candidate.text) || logNote(candidate.text)) ? { names, latest } : undefined
  }
  const scored = scoreCandidates(query, pool, opts.now)
  for (const hit of scored) {
    if (/^retired: /.test(hit.text)) continue
    const priorCycle = /\bbeta[. -]?(\d+)\b/i.exec(hit.text)?.[1]
    if (!hit.pinned && cycle && priorCycle && Number(cycle) > Number(priorCycle) && PLAN_WORDS.test(hit.text)) continue
    const cosine = semantic.get(hit.id) ?? null
    const admission = !hit.pinned && logNote(hit.text) ? (hit.features.discriminatingStems >= 2 && hit.features.rareStems >= STEM_RARE_MIN ? 'stems' : hit.features.maxIdf >= RARE_STEM_IDF && hit.features.bm25 >= RARE_STEM_BM25 ? 'rare-stem' : cosine !== null && cosine >= SEMANTIC_FLOOR ? 'semantic' : opts.rareTier && hit.features.rareStems >= 1 ? 'rare-tier' : null) : taskConstraint(hit.text, query, opts.files ?? []) ? 'constraint' : hit.features.discriminatingStems >= 2 && hit.features.rareStems >= STEM_RARE_MIN ? 'stems' : hit.features.maxIdf >= RARE_STEM_IDF && hit.features.bm25 >= RARE_STEM_BM25 ? 'rare-stem' : cosine !== null && cosine >= SEMANTIC_FLOOR ? 'semantic' : opts.rareTier && hit.features.rareStems >= 1 ? 'rare-tier' : null
    if (admission === null) continue
    const { features, time, pinned, kind, useCount, ...row } = hit
    const historical = historicalOf(hit)
    admitted.push({ ...row, score: Math.max(cosine ?? 0, Math.min(1, features.bm25 / 10)) + STEM_BONUS * Math.min(features.discriminatingStems, 4), witness: witnessOf(hit.id, hit.text), admission, bm25: features.bm25, cosine, discriminatingStems: features.discriminatingStems, maxIdf: features.maxIdf, ...(historical ? { historical } : {}) })
  }
  const taken = new Set(admitted.map(row => row.id))
  for (const constraint of admitted.filter(row => row.admission === 'constraint')) {
    for (const companion of companionsOf(constraint, pool, taken, opts.now)) {
      taken.add(companion.id)
      const base = scored.find(row => row.id === companion.id)!
      const { features, time, pinned, kind, useCount, ...row } = base
      const historical = historicalOf(base)
      admitted.push({ ...row, score: Math.min(1, features.bm25 / 10), witness: witnessOf(base.id, base.text), admission: 'companion', bm25: features.bm25, cosine: semantic.get(base.id) ?? null, discriminatingStems: features.discriminatingStems, maxIdf: features.maxIdf, ...(historical ? { historical } : {}) })
    }
  }
  const rank = (row: AutomaticMemoryHit): number => (row.historical ? -2 : row.admission === 'constraint' ? 2 : row.admission === 'companion' ? 1 : row.admission === 'rare-tier' ? -1 : 0)
  return admitted.sort((a, b) => rank(b) - rank(a) || b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit ?? 2)
}

export function lookupFacts(
  query: string,
  opts: { dir?: string; exclude?: ReadonlySet<string>; limit?: number; files?: readonly string[] } = {},
): LookupHit[] {
  if (!mnemeEnabled()) return []
  const dir = opts.dir ?? mnemeLibraryDir()
  const loadedPins = new Set((readPinnedStatus(dir)?.loaded ?? []).map(seq => `seq:${seq}`))
  const exclude = new Set<string>([...(opts.exclude ?? []), ...loadedPins])
  const hits = automaticMemoryCandidates(query, { dir, files: opts.files }).slice(0, Math.min(2, opts.limit ?? 2)).filter(hit => !exclude.has(hit.id))
  noteMemoryOffered(query, hits, dir)
  return hits
}
