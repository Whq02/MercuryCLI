import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fuseRankings, scoreCandidates, type LookupCandidate } from '../../src/mneme/mnemeLookup.js'

export interface StudyFootnotes {
  session?: number
  ruling?: string
  supersedes?: string
}

export interface StudyCandidate {
  id: string
  seq?: number
  slug: string
  pending: boolean
  pinned?: boolean
  kind?: 'fact' | 'ruling' | 'pending' | 'handoff' | 'session'
  time?: string
  directUseCount: number
  flowedUseCount: number
  footnotes: StudyFootnotes
  text?: string
}

export interface StudyQuestion {
  id: string
  target: string
  session?: number
  ruling?: string
  query: string
}

export interface StudyModelRow {
  name: string
  class: string
  bytes: number
  license: string
  dimension: number
  layers: number
}

export interface StudySimEntry {
  id: string
  sim: number
}

export interface StudyCorpus {
  recordedAt: string
  candidates: StudyCandidate[]
  questions: StudyQuestion[]
  models: StudyModelRow[]
  similaritiesByModel: Record<string, Record<string, StudySimEntry[]>>
}

export interface RecallCount {
  at1: number
  at5: number
  total: number
}

export interface ComputedModelRow extends StudyModelRow {
  semantic: RecallCount
  fusedRank: RecallCount
  fusedInsertion: RecallCount
  measured: boolean
}

export interface SignalAblationRow {
  signal: string
  recallAt1: number
  recallAt5: number
  sameSessionAt5: number
  totalQuestions: number
}

export function loadStudyCorpus(path: string): StudyCorpus {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as StudyCorpus
  if (!raw || !Array.isArray(raw.candidates) || !Array.isArray(raw.questions) || !Array.isArray(raw.models)) {
    throw new Error('invalid semantic study corpus')
  }
  if (typeof raw.similaritiesByModel !== 'object' || raw.similaritiesByModel === null) raw.similaritiesByModel = {}
  return raw
}

export function selectDiscriminatingSemantic(sims: readonly StudySimEntry[]): string[] {
  if (sims.length === 0) return []
  const mean = sims.reduce((s, x) => s + x.sim, 0) / sims.length
  const std = Math.sqrt(sims.reduce((s, x) => s + (x.sim - mean) ** 2, 0) / sims.length) || 1
  const floor = mean + 0.5 * std
  return sims.filter((x, i) => i < 8 && x.sim >= floor).map(x => x.id)
}

export function fuseByRank(semantic: readonly string[], lexical: readonly string[], k = 60): string[] {
  return fuseRankings(semantic.length > 0 ? [[...semantic], [...lexical]] : [[...lexical]], k)
}

export function fuseByInsertion(semantic: readonly string[], lexical: readonly string[]): string[] {
  if (semantic.length === 0) return [...lexical]
  const inBase = new Set(lexical)
  const merged = [...lexical]
  for (const id of semantic.filter(s => !inBase.has(s))) {
    const anchor = semantic.find(s => inBase.has(s) && merged.includes(s))
    if (anchor === undefined) merged.push(id)
    else merged.splice(merged.indexOf(anchor) + 1, 0, id)
  }
  return merged
}

function toLookupPool(candidates: readonly StudyCandidate[], useFlowed: boolean): LookupCandidate[] {
  return candidates.map(c => ({
    id: c.id,
    seq: c.seq,
    slug: c.slug,
    pagePath: c.slug,
    pending: c.pending,
    pinned: c.pinned,
    kind: c.kind,
    time: c.time,
    useCount: useFlowed ? c.flowedUseCount : c.directUseCount,
    signature: '',
    text: c.text ?? c.id,
  }))
}

function studyNow(corpus: StudyCorpus): number {
  return Date.parse(corpus.recordedAt) || Date.parse('2026-10-14T05:00:00.000Z')
}

export function lexicalOrder(corpus: StudyCorpus, query: string, useFlowed = false): string[] {
  return scoreCandidates(query, toLookupPool(corpus.candidates, useFlowed), studyNow(corpus))
    .filter(h => h.features.discriminating)
    .sort((a, b) => b.score - a.score || b.features.useCount - a.features.useCount || (b.seq ?? 999999) - (a.seq ?? 999999))
    .map(h => h.id)
}

export function sortedSemantic(sims: readonly StudySimEntry[] | undefined): string[] {
  return [...(sims ?? [])].sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id)).map(x => x.id)
}

export function countRecall(corpus: StudyCorpus, orderOf: (question: StudyQuestion) => readonly string[]): RecallCount {
  let at1 = 0
  let at5 = 0
  for (const q of corpus.questions) {
    const order = orderOf(q)
    if (order[0] === q.target) at1++
    if (order.slice(0, 5).includes(q.target)) at5++
  }
  return { at1, at5, total: corpus.questions.length }
}

export function computeWordBaseline(corpus: StudyCorpus): RecallCount {
  return countRecall(corpus, q => lexicalOrder(corpus, q.query))
}

export function computeModelRows(corpus: StudyCorpus): ComputedModelRow[] {
  return corpus.models.map(m => {
    const sims = corpus.similaritiesByModel[m.name]
    const measured = sims !== undefined && corpus.questions.every(q => (sims[q.id]?.length ?? 0) > 0)
    const empty: RecallCount = { at1: 0, at5: 0, total: corpus.questions.length }
    if (!measured) return { ...m, semantic: empty, fusedRank: empty, fusedInsertion: empty, measured }
    return {
      ...m,
      measured,
      semantic: countRecall(corpus, q => sortedSemantic(sims[q.id])),
      fusedRank: countRecall(corpus, q => fuseByRank(selectDiscriminatingSemantic(sims[q.id] ?? []), lexicalOrder(corpus, q.query))),
      fusedInsertion: countRecall(corpus, q => fuseByInsertion(selectDiscriminatingSemantic(sims[q.id] ?? []), lexicalOrder(corpus, q.query))),
    }
  })
}

export function chooseModelByOwnerRuling(rows: readonly ComputedModelRow[], wordRecallAt5: number): ComputedModelRow | null {
  const eligible = rows.filter(m => m.measured && (m.license === 'MIT' || m.license === 'Apache-2.0') && Math.max(m.semantic.at5, m.fusedRank.at5) > wordRecallAt5)
  if (eligible.length === 0) return null
  return [...eligible].sort((a, b) =>
    Math.max(b.semantic.at5, b.fusedRank.at5) - Math.max(a.semantic.at5, a.fusedRank.at5) ||
    b.semantic.at1 - a.semantic.at1 ||
    b.fusedRank.at1 - a.fusedRank.at1 ||
    b.bytes - a.bytes,
  )[0] ?? null
}

export function buildLinkRanking(
  baseOrder: readonly string[],
  lex: readonly string[],
  sem: readonly string[],
  byId: ReadonlyMap<string, StudyCandidate>,
  opts: { supersedes: boolean; ruling?: string; session?: number },
  k = 60,
): string[] {
  if (baseOrder.length === 0) return []
  const baseRank = new Map(baseOrder.map((id, idx) => [id, idx]))
  const lexRank = new Map(lex.map((id, idx) => [id, idx]))
  const semRank = new Map(sem.map((id, idx) => [id, idx]))
  const scoreOf = (id: string): number => {
    let s = 0
    const sr = semRank.get(id)
    if (sr !== undefined) s += 1 / (k + sr + 1)
    const lr = lexRank.get(id)
    if (lr !== undefined) s += 1 / (k + lr + 1)
    const c = byId.get(id)
    if (!c) return s
    if (opts.ruling && (c.footnotes.ruling === opts.ruling || c.id === opts.ruling)) {
      s += 1 / (k + 1)
    }
    if (opts.session !== undefined && c.footnotes.session !== undefined) {
      if (c.footnotes.session === opts.session) s += 0.00060
      else if (c.footnotes.session < opts.session) s += 0.00020
    }
    if (opts.supersedes) {
      const flowed = Math.max(0, c.flowedUseCount - c.directUseCount)
      if (flowed > 0) s += Math.min(0.00120, 0.00080 * Math.log1p(flowed))
    }
    return s
  }
  return [...baseOrder].sort((aId, bId) => scoreOf(bId) - scoreOf(aId) || (baseRank.get(aId) ?? 999) - (baseRank.get(bId) ?? 999))
}

export function evaluateSignalAblation(corpus: StudyCorpus, modelName = defaultStudyModel(corpus)): SignalAblationRow[] {
  const simsMap = corpus.similaritiesByModel[modelName] ?? {}
  const byId = new Map(corpus.candidates.map(c => [c.id, c]))
  const arms: Array<{ name: string; semantic: boolean; supersedes: boolean; ruling: boolean; session: boolean }> = [
    { name: 'word-only', semantic: false, supersedes: false, ruling: false, session: false },
    { name: 'word+semantic', semantic: true, supersedes: false, ruling: false, session: false },
    { name: 'word+semantic+supersedes', semantic: true, supersedes: true, ruling: false, session: false },
    { name: 'word+semantic+ruling', semantic: true, supersedes: false, ruling: true, session: false },
    { name: 'word+semantic+session', semantic: true, supersedes: false, ruling: false, session: true },
    { name: 'word+semantic+links-all', semantic: true, supersedes: true, ruling: true, session: true },
  ]
  return arms.map(arm => {
    let r1 = 0
    let r5 = 0
    let sameSessionHits = 0
    let sameSessionDenom = 0
    for (const q of corpus.questions) {
      const lex = lexicalOrder(corpus, q.query, arm.supersedes)
      const sims = simsMap[q.id] ?? []
      const sem = arm.semantic && sims.length > 0 ? selectDiscriminatingSemantic(sims) : []
      const baseOrder = fuseByRank(sem, lex)
      const finalOrder = (arm.supersedes || arm.ruling || arm.session)
        ? buildLinkRanking(baseOrder, lex, sem, byId, {
            supersedes: arm.supersedes,
            ...(arm.ruling && q.ruling ? { ruling: q.ruling } : {}),
            ...(arm.session && q.session !== undefined ? { session: q.session } : {}),
          })
        : baseOrder
      const top5 = finalOrder.slice(0, 5)
      if (finalOrder[0] === q.target) r1++
      if (top5.includes(q.target)) r5++
      if (q.session !== undefined && top5.length > 0) {
        sameSessionDenom += top5.length
        for (const id of top5) {
          if (byId.get(id)?.footnotes.session === q.session) sameSessionHits++
        }
      }
    }
    return {
      signal: arm.name,
      recallAt1: r1,
      recallAt5: r5,
      sameSessionAt5: sameSessionDenom > 0 ? sameSessionHits / sameSessionDenom : 0,
      totalQuestions: corpus.questions.length,
    }
  })
}

export function defaultStudyModel(corpus: StudyCorpus): string {
  const measured = Object.keys(corpus.similaritiesByModel)
  return measured.includes('bge-base-en-v1.5-q8_0') ? 'bge-base-en-v1.5-q8_0' : (measured[0] ?? 'bge-base-en-v1.5-q8_0')
}

const pct = (n: number, total: number): string => `${n}/${total} (${total > 0 ? ((100 * n) / total).toFixed(1) : '0.0'}%)`

export function renderStudyReport(corpus: StudyCorpus): string {
  const N = corpus.questions.length
  const word = computeWordBaseline(corpus)
  const rows = computeModelRows(corpus)
  const chosen = chooseModelByOwnerRuling(rows, word.at5)
  const ablations = evaluateSignalAblation(corpus)
  const lines: string[] = [
    `questions=${N} candidates=${corpus.candidates.length} measured=${rows.filter(r => r.measured).length}/${rows.length} chosen=${chosen?.name ?? 'none'} (computed on this run from the corpus's similarities and the product's word ranking)`,
    '| model | class | size (MB) | licence | dim | layers | sem recall@1 | sem recall@5 | fused@1 (rank fusion) | fused@5 (rank fusion) | fused@1 (insertion) | fused@5 (insertion) |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| word-only (BM25×recency) | baseline | 0 | built-in | 0 | 0 | ${pct(word.at1, N)} | ${pct(word.at5, N)} | ${pct(word.at1, N)} | ${pct(word.at5, N)} | ${pct(word.at1, N)} | ${pct(word.at5, N)} |`,
  ]
  for (const m of rows) {
    const mb = (m.bytes / 1_000_000).toFixed(1)
    if (!m.measured) {
      lines.push(`| ${m.name} | ${m.class} | ${mb} | ${m.license} | ${m.dimension} | ${m.layers} | not measured | not measured | not measured | not measured | not measured | not measured |`)
      continue
    }
    lines.push(
      `| ${m.name} | ${m.class} | ${mb} | ${m.license} | ${m.dimension} | ${m.layers} | ${pct(m.semantic.at1, N)} | ${pct(m.semantic.at5, N)} | ${pct(m.fusedRank.at1, N)} | ${pct(m.fusedRank.at5, N)} | ${pct(m.fusedInsertion.at1, N)} | ${pct(m.fusedInsertion.at5, N)} |`,
    )
  }
  lines.push(
    '',
    `| signal arm (${defaultStudyModel(corpus)}) | recall@1 | recall@5 | same-session share of top-5 (rises with the session boost by construction) |`,
    '| --- | ---: | ---: | ---: |',
  )
  for (const row of ablations) {
    lines.push(`| ${row.signal} | ${pct(row.recallAt1, row.totalQuestions)} | ${pct(row.recallAt5, row.totalQuestions)} | ${(100 * row.sameSessionAt5).toFixed(1)}% |`)
  }
  return lines.join('\n')
}

export const STUDY_FIXTURE_PATH = join(import.meta.dir, 'fixtures/study-corpus.json')

if (import.meta.main) {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--corpus')
  const path = resolve(idx >= 0 && args[idx + 1] ? args[idx + 1]! : STUDY_FIXTURE_PATH)
  console.log(renderStudyReport(loadStudyCorpus(path)))
}
