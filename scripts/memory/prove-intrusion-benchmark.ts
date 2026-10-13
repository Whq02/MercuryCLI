import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lcsLength, loadIntrusionCorpus, measureIntrusion, noteFromRecord, renderIntrusionReport, stemTokens } from './bench-intrusion.js'

const fixture = join(import.meta.dir, 'fixtures/intrusion/pairs.json')
const pairs = loadIntrusionCorpus(fixture)
assert.equal(pairs.length, 20)
assert.deepEqual(stemTokens('Running birds walked'), ['run', 'bird', 'walk'])
assert.equal(lcsLength(['a', 'b', 'a'], ['b', 'a', 'b']), 2)
assert.equal(lcsLength([], ['a']), 0)
assert.deepEqual(measureIntrusion({ note: '', answer: '' }), { lcs: 0, bigramShare: 0, overlap: 0, signal: false })
assert.equal(measureIntrusion({ note: 'amber ribbons identify crates', answer: 'amber ribbons identify crates' }).overlap, 1)
assert.equal(measureIntrusion({ note: 'amber ribbons identify crates', answer: 'amber ribbons identify crates', question: 'amber ribbons identify crates' }).bigramShare, 0)
assert.equal(noteFromRecord('none (a fresh home; no record)'), '')
assert.equal(noteFromRecord('# Lineage\nSession 2\n\n## The last note left (session 1)\nkeep this note'), 'keep this note')
const measured = pairs.map(pair => ({ ...pair, ...measureIntrusion(pair) }))
for (const row of measured) {
  assert.equal(row.signal, row.label !== 'clean', `fixed pair ${row.id}: content repeated or unrelated`)
}
const raw = readFileSync(fixture, 'utf8')
assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(raw))
assert(!/[A-Za-z0-9_+/=-]{28,}/.test(raw))
const report = renderIntrusionReport(pairs, 'Q2')
assert(/^overlap=\d\.\d{6} rows=20/m.test(report))
assert(report.includes('| arm | family |') && report.includes('agreement') && report.includes('unavailable'))
assert(report.includes('same-project reference') && report.includes('overlap is not intrusion'))
const uncertain = renderIntrusionReport([{ ...pairs[0]!, judge: 0.5 }], 'Q1')
assert(uncertain.includes('record_intrudes') && uncertain.includes('| 0 | 1 | 0 | unavailable |'))
const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'bench-intrusion.ts')], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
assert.equal(child.exitCode, 0)
assert.equal(child.stdout.toString().trim(), report)
const missing = Bun.spawnSync([process.execPath, join(import.meta.dir, 'bench-intrusion.ts'), '--corpus', join(import.meta.dir, 'fixtures/intrusion/absent.json')], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
assert.equal(missing.exitCode, 0, 'an unavailable benchmark remains a guide')
assert(missing.stdout.toString().includes('overlap=unavailable'))
console.log(report)
console.log('PASS intrusion benchmark: formula, twenty labelled pairs, scrubbed data, number and table; no performance gate')
process.exit(0)
