import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chooseModelByOwnerRuling,
  evaluateSignalAblation,
  loadStudyCorpus,
  renderStudyReport,
  selectDiscriminatingSemantic,
} from '../memory-study/bench-semantic-recall.js'

const fixturePath = join(import.meta.dir, '../memory-study/fixtures/study-corpus.json')
const corpus = loadStudyCorpus(fixturePath)
assert.equal(corpus.candidates.length, 10)
assert.equal(corpus.questions.length, 10)
assert.equal(corpus.models.length, 5)

const chosen = chooseModelByOwnerRuling(corpus.models, 21)
assert.ok(chosen !== null)
assert.equal(chosen.name, 'bge-base-en-v1.5-q8_0')
assert.equal(chosen.license, 'MIT')
assert.equal(chosen.class, '100-300 MB')
assert.ok(chosen.semanticRecallAt5 > 21)

assert.deepEqual(selectDiscriminatingSemantic([]), [])
const topSem = selectDiscriminatingSemantic(corpus.similaritiesByModel['bge-base-en-v1.5-q8_0']!.Q01!)
assert.equal(topSem[0], 'seq:7')

const ablations = evaluateSignalAblation(corpus)
const byName = new Map(ablations.map(row => [row.signal, row]))
const wordOnly = byName.get('word-only')!
const wordSem = byName.get('word+semantic')!
const withSup = byName.get('word+semantic+supersedes')!
const withRul = byName.get('word+semantic+ruling')!
const withSes = byName.get('word+semantic+session')!
const withAll = byName.get('word+semantic+links-all')!

assert.ok(wordSem.recallAt5 > wordOnly.recallAt5, 'semantic signal moves recall@5 on laptop clock -> notebook time zone')
assert.ok(withSup.recallAt1 > wordSem.recallAt1, 'supersedes usage flow moves recall@1')
assert.ok(withRul.recallAt1 > wordSem.recallAt1, 'ruling link boost moves recall@1')
assert.ok(withSes.recallAt1 > wordSem.recallAt1, 'session link boost moves recall@1')
assert.equal(withAll.recallAt1, 10)
assert.equal(withAll.recallAt5, 10)

const raw = readFileSync(fixturePath, 'utf8')
assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(raw))
assert(!/[A-Za-z0-9_+/=-]{28,}/.test(raw))

const report = renderStudyReport(corpus)
assert(report.includes('chosen=bge-base-en-v1.5-q8_0'))
assert(report.includes('| bge-base-en-v1.5-q8_0 | 100-300 MB | 118.0 | MIT |'))
assert(report.includes('| word+semantic+links-all | 10/10 (100.0%) | 10/10 (100.0%) |'))

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
console.log('PASS semantic study rig: 5 candidate models, owner ruling choice, and per-signal ablation verified')
