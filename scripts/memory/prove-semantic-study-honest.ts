#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LookupCandidate } from '../../src/mneme/mnemeLookup.js'
import type { StudyCorpus } from '../memory-study/bench-semantic-recall.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const proofHome = mkdtempSync(join(tmpdir(), 'semantic-study-honest-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { fuseRankings, scoreCandidates } = await import('../../src/mneme/mnemeLookup.js')
const {
  computeModelRows,
  computeWordBaseline,
  evaluateSignalAblation,
  fuseByInsertion,
  loadStudyCorpus,
  renderStudyReport,
  selectDiscriminatingSemantic,
  STUDY_FIXTURE_PATH,
} = await import('../memory-study/bench-semantic-recall.js')
const { openRecorder, recordSimilarities } = await import('../memory-study/record-semantic-similarities.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)

const corpus: StudyCorpus = loadStudyCorpus(STUDY_FIXTURE_PATH)
const N = corpus.questions.length
const now = Date.parse(corpus.recordedAt)

const pool = (): LookupCandidate[] => corpus.candidates.map(c => ({ id: c.id, seq: c.seq, slug: c.slug, pagePath: c.slug, pending: c.pending, pinned: c.pinned, kind: c.kind, time: c.time, useCount: c.directUseCount, signature: '', text: c.text ?? c.id }))
const lexOrder = (query: string): string[] => scoreCandidates(query, pool(), now)
  .filter(h => h.features.discriminating)
  .sort((a, b) => b.score - a.score || b.features.useCount - a.features.useCount || (b.seq ?? 999999) - (a.seq ?? 999999))
  .map(h => h.id)
const recall = (orderOf: (qid: string, query: string) => string[]): { r1: number; r5: number } => {
  let r1 = 0
  let r5 = 0
  for (const q of corpus.questions) {
    const order = orderOf(q.id, q.query)
    if (order[0] === q.target) r1++
    if (order.slice(0, 5).includes(q.target)) r5++
  }
  return { r1, r5 }
}

console.log(`\n[T] the table the rig prints is the table the rig computes (fixture: ${N} questions, ${corpus.candidates.length} candidates)`)
{
  const rows = computeModelRows(corpus)
  const word = computeWordBaseline(corpus)
  const independentWord = recall((_, query) => lexOrder(query))
  check('the word-only baseline is the real product ranking on this corpus', word.at1 === independentWord.r1 && word.at5 === independentWord.r5 && word.total === N, JSON.stringify(word))
  check('every model row in the corpus is a static fact row — no recorded recall counts ride the record', corpus.models.every(m => !('semanticRecallAt1' in m) && !('fusedRecallAt5' in m)), JSON.stringify(corpus.models[0]))
  for (const m of rows) {
    const sims = corpus.similaritiesByModel[m.name]
    check(`${m.name}: the row is measured (its similarities cover every question)`, m.measured && sims !== undefined && corpus.questions.every(q => (sims[q.id]?.length ?? 0) === corpus.candidates.length), m.measured ? '' : 'no similarities — the row would print "not measured"')
    if (!m.measured || sims === undefined) continue
    const sem = recall(qid => [...sims[qid]!].sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id)).map(x => x.id))
    const fusedRank = recall((qid, query) => {
      const s = selectDiscriminatingSemantic(sims[qid]!)
      const lex = lexOrder(query)
      return fuseRankings(s.length > 0 ? [s, lex] : [lex])
    })
    const fusedInsertion = recall((qid, query) => fuseByInsertion(selectDiscriminatingSemantic(sims[qid]!), lexOrder(query)))
    check(`${m.name}: the semantic columns are what its similarities give`, sem.r1 === m.semantic.at1 && sem.r5 === m.semantic.at5 && m.semantic.total === N, `computed ${sem.r1}/${sem.r5}, rig ${m.semantic.at1}/${m.semantic.at5}`)
    check(`${m.name}: the rank-fusion columns follow the rig's rule`, fusedRank.r1 === m.fusedRank.at1 && fusedRank.r5 === m.fusedRank.at5, `computed ${fusedRank.r1}/${fusedRank.r5}, rig ${m.fusedRank.at1}/${m.fusedRank.at5}`)
    check(`${m.name}: the insertion columns follow the rig's rule`, fusedInsertion.r1 === m.fusedInsertion.at1 && fusedInsertion.r5 === m.fusedInsertion.at5, `computed ${fusedInsertion.r1}/${fusedInsertion.r5}, rig ${m.fusedInsertion.at1}/${m.fusedInsertion.at5}`)
  }
  const ablation = evaluateSignalAblation(corpus).find(r => r.signal === 'word-only')
  check('the word-only arm of the ablation is the same real ranking', ablation !== undefined && ablation.recallAt1 === word.at1 && ablation.recallAt5 === word.at5, JSON.stringify(ablation))
  const report = renderStudyReport(corpus)
  const baselineRow = report.split('\n').find(l => l.startsWith('| word-only')) ?? ''
  check('the printed word-only row carries the computed counts over this corpus\'s question count', baselineRow.includes(`| ${word.at1}/${N} (`) && baselineRow.includes(`| ${word.at5}/${N} (`), baselineRow)
  check('every printed model row carries its computed counts', rows.every(m => report.includes(`| ${m.name} |`) && report.includes(`| ${m.semantic.at1}/${N} (`) && report.includes(`| ${m.fusedRank.at5}/${N} (`)), report.split('\n').slice(0, 4).join(' / '))
  check('the printed headline says the table is computed on this run', report.split('\n')[0]!.includes('computed on this run'), report.split('\n')[0])
}

console.log('\n[M] the fixture\'s similarities are the shipped model\'s own')
{
  const { EMBED_MODELS, EMBED_MODELS_VENDOR_PATH, embedDefaultModel } = await import('../../src/mneme/embedModels.js')
  const recorder = openRecorder(ROOT)
  if (recorder === null) {
    warn('no embed pack on this host — the in-process leg is skipped (bun run scripts/vendor/build-embed.ts builds it)')
  } else {
    const names = [embedDefaultModel().name, ...Object.keys(corpus.similaritiesByModel).filter(n => n !== embedDefaultModel().name)]
    for (const name of names) {
      const row = EMBED_MODELS.find(r => r.name === name)
      const file = row ? join(ROOT, EMBED_MODELS_VENDOR_PATH, row.file) : ''
      if (!row || !existsSync(file)) {
        if (name === embedDefaultModel().name) check(`${name}: the shipped model's weights are in ${EMBED_MODELS_VENDOR_PATH} for the provers`, false, `bun run scripts/vendor/fetch-embed-models.ts --model ${name}`)
        else warn(`${name}: the weights are not in ${EMBED_MODELS_VENDOR_PATH} — skipped (bun run scripts/vendor/fetch-embed-models.ts --model ${name})`)
        continue
      }
      const live = recordSimilarities(corpus, recorder, file)
      const recorded = corpus.similaritiesByModel[name] ?? {}
      let maxDelta = 0
      let compared = 0
      let topAgree = 0
      for (const q of corpus.questions) {
        const liveBy = new Map((live[q.id] ?? []).map(x => [x.id, x.sim]))
        for (const r of recorded[q.id] ?? []) {
          const l = liveBy.get(r.id)
          if (l !== undefined) {
            maxDelta = Math.max(maxDelta, Math.abs(l - r.sim))
            compared++
          }
        }
        if ((recorded[q.id] ?? [])[0]?.id === (live[q.id] ?? [])[0]?.id) topAgree++
      }
      check(`${name}: every recorded similarity is the model's own (|Δ| ≤ 0.001 over ${compared} pairs)`, compared === N * corpus.candidates.length && maxDelta <= 0.001, `max |Δsim| ${maxDelta.toFixed(4)}, ${compared} pairs`)
      check(`${name}: the recorded top candidate is the model's top candidate on every question`, topAgree === N, `${topAgree}/${N} agree`)
    }
  }
}

console.log(failures > 0 ? `\nprove-semantic-study-honest: RED (${failures})` : '\nprove-semantic-study-honest: green')
process.exit(failures > 0 ? 1 : 0)
