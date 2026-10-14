#!/usr/bin/env bun
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fuseRankings, scoreCandidates, type LookupCandidate } from '../../src/mneme/mnemeLookup.js'
import { evaluateSignalAblation, loadStudyCorpus, renderStudyReport, selectDiscriminatingSemantic, type StudyCorpus } from '../memory-study/bench-semantic-recall.js'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'semantic-study-honest-'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)

const fixturePath = join(import.meta.dir, '../memory-study/fixtures/study-corpus.json')
const corpus: StudyCorpus = loadStudyCorpus(fixturePath)
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
  for (const m of corpus.models) {
    check(`${m.name}: a recall count never exceeds the question count`, m.semanticRecallAt1 <= N && m.semanticRecallAt5 <= N && m.fusedRecallAt1 <= N && m.fusedRecallAt5 <= N, `recorded sem ${m.semanticRecallAt1}/${m.semanticRecallAt5} fused ${m.fusedRecallAt1}/${m.fusedRecallAt5} on ${N} questions`)
    const sims = corpus.similaritiesByModel[m.name]
    if (sims === undefined) {
      check(`${m.name}: a row in the table carries the similarities it was computed from`, false, 'no similaritiesByModel entry — the row is a recorded constant')
      continue
    }
    const sem = recall(qid => [...(sims[qid] ?? [])].sort((a, b) => b.sim - a.sim).map(x => x.id))
    const fused = recall((qid, query) => {
      const s = selectDiscriminatingSemantic(sims[qid] ?? [])
      const lex = lexOrder(query)
      return fuseRankings(s.length > 0 ? [s, lex] : [lex])
    })
    check(`${m.name}: the semantic columns are what its similarities give on this corpus`, sem.r1 === m.semanticRecallAt1 && sem.r5 === m.semanticRecallAt5, `computed ${sem.r1}/${sem.r5}, recorded ${m.semanticRecallAt1}/${m.semanticRecallAt5}`)
    check(`${m.name}: the fused columns are what the rig's own fusion rule gives on this corpus`, fused.r1 === m.fusedRecallAt1 && fused.r5 === m.fusedRecallAt5, `computed ${fused.r1}/${fused.r5}, recorded ${m.fusedRecallAt1}/${m.fusedRecallAt5}`)
  }
  const word = recall((_, query) => lexOrder(query))
  const ablation = evaluateSignalAblation(corpus).find(r => r.signal === 'word-only')
  check('the word-only arm of the ablation is the real product ranking on this corpus', ablation !== undefined && ablation.recallAt1 === word.r1 && ablation.recallAt5 === word.r5, JSON.stringify(ablation))
  const report = renderStudyReport(corpus)
  const baselineRow = report.split('\n').find(l => l.startsWith('| word-only')) ?? ''
  check('the word-only row of the printed table is computed, not a literal', baselineRow.includes(`${word.r1}/${N}`) && baselineRow.includes(`${word.r5}/${N}`), baselineRow)
  check('every printed model row names recall over this corpus\'s question count', corpus.models.every(m => report.includes(`| ${m.name} |`) && report.includes(`${m.semanticRecallAt5}/${N} (`)), report.split('\n').slice(1, 4).join(' / '))
}

console.log('\n[M] the fixture\'s similarities are the model\'s own')
{
  const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
  const { EMBED_ADDON_FILE, embedPackDirFor } = await import('../../src/mneme/embedPack.js')
  const { EMBED_MODELS, EMBED_MODELS_VENDOR_PATH } = await import('../../src/mneme/embedModels.js')
  const addonPath = join(embedPackDirFor(ROOT, voicePackPlatform()), EMBED_ADDON_FILE)
  if (!existsSync(addonPath)) {
    warn(`no embed pack at ${addonPath} — the in-process leg is skipped (bun run scripts/vendor/build-embed.ts builds it)`)
  } else {
    const addon = createRequire(import.meta.url)(addonPath) as { loadModel(p: string): number; embed(h: number, t: string, q?: boolean): number[]; unloadModel(h: number): void }
    for (const name of Object.keys(corpus.similaritiesByModel)) {
      const row = EMBED_MODELS.find(r => r.name === name)
      const file = row ? join(ROOT, EMBED_MODELS_VENDOR_PATH, row.file) : ''
      if (!row || !existsSync(file)) {
        warn(`${name}: the weights are not in ${EMBED_MODELS_VENDOR_PATH} — skipped (bun run scripts/vendor/fetch-embed-models.ts --model ${name})`)
        continue
      }
      const handle = addon.loadModel(file)
      const docs = new Map(corpus.candidates.map(c => [c.id, addon.embed(handle, c.text ?? c.id, false)]))
      let maxDelta = 0
      let topAgree = 0
      let compared = 0
      for (const q of corpus.questions) {
        const qv = addon.embed(handle, q.query, true)
        const live = new Map(corpus.candidates.map(c => { const dv = docs.get(c.id)!; let s = 0; for (let i = 0; i < qv.length; i++) s += qv[i]! * dv[i]!; return [c.id, s] as const }))
        const recorded = corpus.similaritiesByModel[name]![q.id] ?? []
        for (const r of recorded) { const l = live.get(r.id); if (l !== undefined) { maxDelta = Math.max(maxDelta, Math.abs(l - r.sim)); compared++ } }
        const recTop = [...recorded].sort((a, b) => b.sim - a.sim)[0]?.id
        const liveTop = [...live.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        if (recTop !== undefined && recTop === liveTop) topAgree++
      }
      addon.unloadModel(handle)
      check(`${name}: every recorded similarity is the model's own (|Δ| ≤ 0.01 over ${compared} pairs)`, compared > 0 && maxDelta <= 0.01, `max |Δsim| ${maxDelta.toFixed(4)}`)
      check(`${name}: the recorded top candidate is the model's top candidate on every question`, topAgree === N, `${topAgree}/${N} agree`)
    }
  }
}

console.log(failures > 0 ? `\nprove-semantic-study-honest: RED (${failures})` : '\nprove-semantic-study-honest: green')
process.exit(failures > 0 ? 1 : 0)
