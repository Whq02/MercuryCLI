#!/usr/bin/env bun
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'recall-first-five-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
type Row = { id: string; target: string; baseline: string[]; expected: string[]; scores: Record<string, number> }
const rows: Row[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/recall-first-five.json'), 'utf8'))
let active: Row = rows[0]!
let available = true
let searches = 0
mock.module('../../src/mneme/mnemeIndex.js', () => ({
  readEmbedIndex: () => available ? {} : null,
  embedIndexEngineStatus: () => ({ state: 'ok' }),
  searchEmbedIndex: (_query: string, _index: unknown, _engine: unknown, limit: number) => {
    searches++
    return Object.entries(active.scores).map(([key, sim]) => ({ key, sim })).sort((a, b) => b.sim - a.sim).slice(0, limit)
  },
  rebuildEmbedIndex: () => { throw new Error('ranking must not encode documents') },
}))
mock.module('../../src/mneme/mnemeSignalRanking.js', () => ({
  fuseSignalRanking: (_rankings: unknown, _scored: unknown, _dir: string, _fuse: unknown, _extra: unknown, refine?: (order: string[]) => string[]) => refine ? refine([...active.baseline]) : [...active.baseline],
}))
const { fuseRecallRankings } = await import('../../src/mneme/mnemeLookup.js')
const pool = () => Object.keys(active.scores).map(id => ({ id, seq: id.startsWith('seq:') ? Number(id.slice(4)) : undefined, text: 'fixture', pending: id.startsWith('pending:'), signature: '', slug: 'facts', pagePath: 'facts' }))
try {
  const ranks: number[] = []
  for (const row of rows) {
    active = row
    const before = searches
    const result = fuseRecallRankings(row.id, pool(), [], { dir: scratch })
    assert.equal(searches - before, 1)
    assert.deepEqual([...result.slice(0, 5)].sort(), [...row.baseline.slice(0, 5)].sort())
    assert.deepEqual(result.slice(5), row.baseline.slice(5))
    ranks.push(result.indexOf(row.target) + 1)
  }
  const first = ranks.filter(rank => rank === 1).length
  const five = ranks.filter(rank => rank > 0 && rank <= 5).length
  console.log(`recorded numeric corpus @1 ${first}/25; @5 ${five}/25; one cached score pass per query`)
  assert.equal(rows.filter(r => r.baseline[0] === r.target).length, 16)
  assert.equal(first, 19)
  assert.equal(five, 25)
  for (const row of rows) {
    active = row
    assert.deepEqual(fuseRecallRankings(row.id, pool(), [], { dir: scratch }), row.expected)
  }
  assert.equal(ranks[3], 4)
  active = rows[0]!
  available = false
  const before = searches
  assert.deepEqual(fuseRecallRankings('no semantic engine', pool(), [], { dir: scratch }), active.baseline)
  assert.equal(searches, before)
  available = true
  active = { id: 'ties', target: 'seq:1', baseline: ['seq:1', 'pending:draft', 'seq:2', 'seq:3', 'seq:4', 'seq:5'], expected: [], scores: { 'seq:1': .7, 'pending:draft': .8, 'seq:2': .8, 'seq:3': .1, 'seq:4': .6, 'seq:5': .99 } }
  assert.deepEqual(fuseRecallRankings('ties', pool(), [], { dir: scratch }), ['pending:draft', 'seq:2', 'seq:1', 'seq:4', 'seq:3', 'seq:5'])
  console.log('PASS conserved membership, unchanged tail, stable ties, pending, fallback and no document encoding')
} finally {
  mock.restore()
  rmSync(scratch, { recursive: true, force: true })
}
