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
  semanticRecallAt1: number
  semanticRecallAt5: number
  fusedRecallAt1: number
  fusedRecallAt5: number
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
  return raw
}

export function selectDiscriminatingSemantic(sims: readonly StudySimEntry[]): string[] {
  if (sims.length === 0) return []
  const mean = sims.reduce((s, x) => s + x.sim, 0) / sims.length
  const std = Math.sqrt(sims.reduce((s, x) => s + (x.sim - mean) ** 2, 0) / sims.length) || 1
  const floor = mean + 0.5 * std
  return sims.filter((x, i) => i < 8 && x.sim >= floor).map(x => x.id)
}

export function chooseModelByOwnerRuling(models: readonly StudyModelRow[], wordRecallAt5: number): StudyModelRow | null {
  const eligible = models.filter(m => (m.license === 'MIT' || m.license === 'Apache-2.0') && Math.max(m.semanticRecallAt5, m.fusedRecallAt5) > wordRecallAt5)
  if (eligible.length === 0) return null
  return [...eligible].sort((a, b) =>
    Math.max(b.semanticRecallAt5, b.fusedRecallAt5) - Math.max(a.semanticRecallAt5, a.fusedRecallAt5) ||
    b.semanticRecallAt1 - a.semanticRecallAt1 ||
    b.fusedRecallAt1 - a.fusedRecallAt1 ||
    b.bytes - a.bytes,
  )[0] ?? null
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
      const inherited = Math.max(0, c.flowedUseCount - c.directUseCount)
      if (inherited > 0) s += Math.min(0.00120, 0.00080 * Math.log1p(inherited))
    }
    return s
  }
  return [...baseOrder].sort((aId, bId) => scoreOf(bId) - scoreOf(aId) || (baseRank.get(aId) ?? 999) - (baseRank.get(bId) ?? 999))
}

export function evaluateSignalAblation(corpus: StudyCorpus, modelName = 'bge-base-en-v1.5-q8_0'): SignalAblationRow[] {
  const now = Date.parse(corpus.recordedAt) || Date.parse('2026-10-14T05:00:00.000Z')
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
    const pool = toLookupPool(corpus.candidates, arm.supersedes)
    let r1 = 0
    let r5 = 0
    let sameSessionHits = 0
    let sameSessionDenom = 0
    for (const q of corpus.questions) {
      const scored = scoreCandidates(q.query, pool, now)
      const lex = scored
        .filter(h => h.features.discriminating)
        .sort((a, b) => b.score - a.score || b.features.useCount - a.features.useCount || (b.seq ?? 999999) - (a.seq ?? 999999))
        .map(h => h.id)
      const sims = simsMap[q.id] ?? []
      const sem = arm.semantic && sims.length > 0 ? selectDiscriminatingSemantic(sims) : []
      const rankings: string[][] = sem.length > 0 ? [sem, lex] : [lex]
      const baseOrder = fuseRankings(rankings)
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

export function renderStudyReport(corpus: StudyCorpus): string {
  const ablations = evaluateSignalAblation(corpus)
  const chosen = chooseModelByOwnerRuling(corpus.models, 21)
  const lines: string[] = [
    `questions=${corpus.questions.length} candidates=${corpus.candidates.length} chosen=${chosen?.name ?? 'none'}`,
    '| model | class | size (MB) | licence | dim | layers | sem recall@1 | sem recall@5 | fused recall@1 | fused recall@5 |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| word-only (BM25xrecency) | baseline | 0 | built-in | 0 | 0 | 11/25 (44.0%) | 21/25 (84.0%) | 11/25 (44.0%) | 21/25 (84.0%) |`,
  ]
  for (const m of corpus.models) {
    const mb = (m.bytes / 1_000_000).toFixed(1)
    lines.push(
      `| ${m.name} | ${m.class} | ${mb} | ${m.license} | ${m.dimension} | ${m.layers} | ${m.semanticRecallAt1}/25 (${((100 * m.semanticRecallAt1) / 25).toFixed(1)}%) | ${m.semanticRecallAt5}/25 (${((100 * m.semanticRecallAt5) / 25).toFixed(1)}%) | ${m.fusedRecallAt1}/25 (${((100 * m.fusedRecallAt1) / 25).toFixed(1)}%) | ${m.fusedRecallAt5}/25 (${((100 * m.fusedRecallAt5) / 25).toFixed(1)}%) |`,
    )
  }
  lines.push(
    '',
    '| signal arm | recall@1 | recall@5 | same-session@5 |',
    '| --- | ---: | ---: | ---: |',
  )
  for (const row of ablations) {
    lines.push(
      `| ${row.signal} | ${row.recallAt1}/${row.totalQuestions} (${((100 * row.recallAt1) / row.totalQuestions).toFixed(1)}%) | ${row.recallAt5}/${row.totalQuestions} (${((100 * row.recallAt5) / row.totalQuestions).toFixed(1)}%) | ${(100 * row.sameSessionAt5).toFixed(1)}% |`,
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--corpus')
  const path = resolve(idx >= 0 && args[idx + 1] ? args[idx + 1]! : join(import.meta.dir, 'fixtures/study-corpus.json'))
  console.log(renderStudyReport(loadStudyCorpus(path)))
}
