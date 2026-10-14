import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chooseModelByOwnerRuling,
  computeModelRows,
  computeWordBaseline,
  evaluateSignalAblation,
  fuseByInsertion,
  fuseByRank,
  loadStudyCorpus,
  renderStudyReport,
  selectDiscriminatingSemantic,
  STUDY_FIXTURE_PATH,
  type ComputedModelRow,
} from '../memory-study/bench-semantic-recall.js'

const corpus = loadStudyCorpus(STUDY_FIXTURE_PATH)
assert.equal(corpus.candidates.length, 10)
assert.equal(corpus.questions.length, 10)
assert.equal(corpus.models.length, 5)
assert.deepEqual(Object.keys(corpus.similaritiesByModel).sort(), corpus.models.map(m => m.name).sort(), 'every model row has recorded similarities')

const word = computeWordBaseline(corpus)
assert.equal(word.total, 10)
const rows = computeModelRows(corpus)
assert.equal(rows.length, 5)
assert.ok(rows.every(r => r.measured), 'every row is measured from its similarities')
assert.ok(rows.every(r => r.semantic.total === 10 && r.semantic.at5 <= 10 && r.fusedRank.at5 <= 10 && r.fusedInsertion.at5 <= 10))

const count = (at1: number, at5: number): { at1: number; at5: number; total: number } => ({ at1, at5, total: 25 })
const row = (name: string, license: string, bytes: number, sem: [number, number], fused: [number, number]): ComputedModelRow => ({
  name, class: 'study', bytes, license, dimension: 768, layers: 12, measured: true,
  semantic: count(...sem), fusedRank: count(...fused), fusedInsertion: count(0, 0),
})
const ruled = chooseModelByOwnerRuling([
  row('small-apache', 'Apache-2.0', 25_000_000, [14, 23], [13, 23]),
  row('base-mit', 'MIT', 118_000_000, [19, 24], [17, 25]),
  row('base-mit-twin', 'MIT', 118_000_000, [18, 24], [18, 23]),
  row('big-gpl', 'GPL-3.0', 500_000_000, [25, 25], [25, 25]),
  row('no-gain', 'MIT', 300_000_000, [10, 21], [11, 21]),
], 21)
assert.ok(ruled !== null)
assert.equal(ruled.name, 'base-mit', 'the owner\'s rule: permissive licence, beats the word baseline at 5, then the best recall at 5, then at 1, then the bigger model')
assert.equal(chooseModelByOwnerRuling([row('no-gain', 'MIT', 300_000_000, [10, 21], [11, 21])], 21), null, 'a model that does not beat the word baseline is not chosen')
assert.equal(chooseModelByOwnerRuling([row('big-gpl', 'GPL-3.0', 500_000_000, [25, 25], [25, 25])], 21), null, 'a non-permissive licence is never chosen')

const chosenOnFixture = chooseModelByOwnerRuling(rows, word.at5)
assert.ok(chosenOnFixture !== null, 'on the fixture some measured model beats the word baseline at 5')

assert.deepEqual(selectDiscriminatingSemantic([]), [])
const q1 = corpus.similaritiesByModel['bge-base-en-v1.5-q8_0']!.Q01!
assert.equal(selectDiscriminatingSemantic(q1)[0], q1[0]!.id, 'the discriminating set keeps the top similarity first')
assert.deepEqual(fuseByRank([], ['a', 'b']), ['a', 'b'], 'no semantic hits leave the word order alone')
assert.deepEqual(fuseByInsertion([], ['a', 'b']), ['a', 'b'])
assert.deepEqual(fuseByInsertion(['x', 'b'], ['a', 'b']), ['a', 'b', 'x'], 'an insertion splices a meaning-only hit after its word-matched neighbour')
assert.equal(fuseByRank(['x', 'b'], ['a', 'b'])[0], 'b', 'rank fusion lifts the hit both orderings hold')

const ablations = evaluateSignalAblation(corpus)
const byName = new Map(ablations.map(r => [r.signal, r]))
for (const arm of ['word-only', 'word+semantic', 'word+semantic+supersedes', 'word+semantic+ruling', 'word+semantic+session', 'word+semantic+links-all']) {
  const r = byName.get(arm)
  assert.ok(r !== undefined && r.totalQuestions === 10 && r.recallAt1 <= r.recallAt5, `the ablation computes the ${arm} arm`)
}
assert.equal(byName.get('word-only')!.recallAt1, word.at1)
assert.equal(byName.get('word-only')!.recallAt5, word.at5)
assert.ok(byName.get('word+semantic')!.recallAt5 >= word.at5, 'the semantic ordering never loses a word hit at 5 on the fixture')

const raw = readFileSync(STUDY_FIXTURE_PATH, 'utf8')
assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(raw))
assert(!/[A-Za-z0-9_+/=-]{28,}/.test(raw))
assert(!raw.includes('semanticRecallAt'), 'no recorded recall count rides the fixture')

const report = renderStudyReport(corpus)
assert(report.includes(`chosen=${chosenOnFixture.name}`))
assert(report.includes('computed on this run'))
assert(report.includes(`| word-only (BM25×recency) | baseline | 0 | built-in | 0 | 0 | ${word.at1}/10 (`))
assert(report.includes('| bge-base-en-v1.5-q8_0 | 100-300 MB | 118.0 | MIT | 768 | 12 |'))
assert(report.includes('| word+semantic+ruling |'))

const child = Bun.spawnSync([process.execPath, join(import.meta.dir, '../memory-study/bench-semantic-recall.ts')], {
  env: process.env,
  stdout: 'pipe',
  stderr: 'pipe',
})
if (child.exitCode !== 0) {
  console.error(child.stderr.toString())
}
assert.equal(child.exitCode, 0)
assert.equal(child.stdout.toString().trim(), report)
console.log(report)
console.log('PASS semantic study rig: five measured models, the owner\'s choice rule, both fusion shapes and the per-signal ablation computed on this run')
