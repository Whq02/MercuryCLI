import assert from 'node:assert/strict'
import { candidates, rankCandidates, scoreCandidates, RECENCY_TAU_MS, type LookupCandidate } from '../../src/mneme/mnemeLookup.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const now = Date.parse('2026-10-13T00:00:00.000Z')
const row = (id: number, extra: Partial<LookupCandidate> = {}): LookupCandidate => ({
  id: `seq:${id}`, seq: id, text: 'quartz deployed', signature: '', slug: 'facts', pagePath: 'facts', pending: false, ...extra,
})
const pool = [
  row(1, { text: 'amber certificates', useCount: 99 }),
  row(2, { time: '2026-10-06T00:00:00.000Z', useCount: 4 }),
  row(3, { time: '2025-10-13T00:00:00.000Z', pinned: true }),
  row(4, { time: '2025-10-13T00:00:00.000Z', kind: 'ruling' }),
  row(5, { id: 'pending:2026-10-13T00:00:00.000Z', seq: undefined, pending: true, time: '2026-10-13T00:00:00.000Z' }),
  row(6, { id: 'ledger:6', kind: 'handoff', useCount: 2 }),
  row(7, { id: 'ledger:7', kind: 'session', useCount: -8 }),
  row(8, { time: 'unknown', useCount: NaN }),
  row(9, { time: '2026-10-14T00:00:00.000Z', useCount: Infinity }),
]
const original = structuredClone(pool)
pool.forEach(Object.freeze)
Object.freeze(pool)
const scores = scoreCandidates('deploying', pool, now)
assert.deepEqual(scores.map(score => score.id), pool.map(candidate => candidate.id))
assert.equal(scores[0]!.score, 0)
assert.deepEqual(scores[0]!.matched, [])
assert.equal(scores[0]!.features.bm25, 0)
assert.equal(scores[0]!.features.discriminating, false)
assert.equal(scores[1]!.features.useCount, 4)
assert.ok(Math.abs(scores[1]!.features.recency - Math.exp(-7 * 86400000 / RECENCY_TAU_MS)) < 1e-12)
assert.equal(scores[1]!.score, scores[1]!.features.bm25 * scores[1]!.features.recency)
assert.equal(scores[2]!.features.pinned, true)
assert.equal(scores[2]!.features.kind, 'ruling')
assert.equal(scores[2]!.features.recency, 1)
assert.equal(scores[3]!.features.pinned, true)
assert.equal(scores[3]!.features.recency, 1)
assert.equal(scores[4]!.features.kind, 'pending')
assert.equal(scores[4]!.features.recency, 1)
assert.equal(scores[5]!.features.kind, 'handoff')
assert.equal(scores[5]!.features.useCount, 2)
assert.equal(scores[6]!.features.kind, 'session')
for (const result of scores.slice(6)) {
  assert.equal(result.features.useCount, 0)
  assert.equal(result.features.recency, 1)
  assert.ok(Number.isFinite(result.score))
}
assert.deepEqual(pool, original)
assert.deepEqual(scoreCandidates('deploying', pool, now), scores)
assert.deepEqual(scoreCandidates('deploying', [], now), [])
for (const query of ['', 'the and run', 'absentterm']) {
  const empty = scoreCandidates(query, pool, now)
  assert.equal(empty.length, pool.length)
  assert.ok(empty.every(result => result.score === 0 && !result.features.discriminating))
}
const universal = scoreCandidates('quartz', [row(20), row(21)], now)
assert.ok(universal.every(result => result.features.bm25 > 0 && !result.features.discriminating && result.score === 0))
const keyFields = ['id', 'matched', 'pagePath', 'pending', 'score', 'seq', 'signature', 'slug', 'text']
assert.ok(rankCandidates('deploying', pool, { now, limit: 20 }).every(hit => JSON.stringify(Object.keys(hit).sort()) === JSON.stringify(keyFields)))

const dir = mkdtempSync(join(tmpdir(), 'recall-features-'))
try {
  const { appendObservation } = await import('../../src/mneme/mnemeBuffer.js')
  const page = join(dir, 'topic-facts.md')
  const content = [
    '---', 'id: topic-facts', 'summary: Fixtures', 'token_count: 12', 'created: 2026-10-13T00:00:00.000Z', 'updated: 2026-10-13T00:00:00.000Z', 'update_log:', '---', '## notes',
    '- Quartz deployed. <seq=1, time=2026-10-06T00:00:00.000Z, source=proof>',
    '- Amber certificates. <seq=2, time=2026-10-12T00:00:00.000Z, source=proof>',
  ].join('\n') + '\n'
  writeFileSync(page, content)
  const pinText = JSON.stringify({ version: 1, pins: [{ seq: 1, at: '2026-10-10T00:00:00.000Z', asked: true }] })
  const useText = JSON.stringify({ version: 1, rows: { '1': { last: '2026-10-11T00:00:00.000Z', count: 7 } } })
  writeFileSync(join(dir, 'pins.json'), pinText)
  writeFileSync(join(dir, 'usage.json'), useText)
  appendObservation({ text: 'Quartz deploying soon.', source: 'proof' }, dir)
  const found = candidates(dir)
  const fact = found.find(candidate => candidate.id === 'seq:1')!
  assert.equal(fact.time, '2026-10-06T00:00:00.000Z')
  assert.equal(fact.pinned, true)
  assert.equal(fact.kind, 'ruling')
  assert.equal(fact.useCount, 7)
  const pending = found.find(candidate => candidate.pending)!
  assert.equal(pending.time, pending.id.slice('pending:'.length))
  assert.equal(pending.kind, 'pending')
  assert.equal(pending.useCount, 0)
  scoreCandidates('deploying', found, now)
  assert.equal(readFileSync(page, 'utf8'), content)
  assert.equal(readFileSync(join(dir, 'pins.json'), 'utf8'), pinText)
  assert.equal(readFileSync(join(dir, 'usage.json'), 'utf8'), useText)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('PASS: all candidate features are pure, complete, repeatable and absent from lookup output')
