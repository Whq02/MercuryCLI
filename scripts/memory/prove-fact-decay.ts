import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'fact-decay-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const refs = await import('../../src/mneme/memoryRefs.ts')
const { searchPointers, renderPointerLine } = await import('../../src/mneme/mnemePointers.ts')
const { writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { emptyDoc, docFileName } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { readUsage } = await import('../../src/mneme/mnemeUsage.ts')
const now = new Date()
const stamp = (days: number) => new Date(now.getTime() - days * 86400000).toISOString()
const dir = join(home, 'library')
const doc = emptyDoc('facts', 'durable notes', stamp(180))
doc.sections = [{ heading: 'notes', entries: [
  ...Array.from({ length: 105 }, (_, i) => ({ seq: i + 1, time: stamp(90), source: 'proof', text: `Archive cold record ${i} keeps its checksum.` })),
  { seq: 106, time: stamp(0), source: 'proof', text: 'Archive warm record keeps its checksum.' },
] }]
writeDoc(doc, dir)
try {
  const before = readFileSync(join(dir, docFileName(doc.slug)), 'utf8')
  const hits = refs.collectMemoryRefs('archive', { libraryDir: dir, maxRefs: 16, now })
  assert.equal(hits.find(h => h.refId === 'mneme:1')?.status, 'stale')
  assert.equal(hits[0]!.refId, 'mneme:106')
  assert(refs.renderMemoryRefLine(hits.find(h => h.refId === 'mneme:1')!).includes(`[stale — not confirmed since ${stamp(90).slice(0, 10)}]`))
  const pointers = searchPointers('archive', { dir, limit: 2, sessions: [], now }).pointers
  assert.equal(pointers[0]?.id, 'seq:106')
  assert(pointers[1]?.title.includes(`[stale — not confirmed since ${stamp(90).slice(0, 10)}]`))
  assert.deepEqual(Object.keys(pointers[1]!).sort(), ['footnotes', 'id', 'kind', 'title'])
  assert(renderPointerLine(pointers[1]!).includes('[stale — not confirmed since'))
  assert.deepEqual(readUsage(dir), {})
  assert.equal(readFileSync(join(dir, docFileName(doc.slug)), 'utf8'), before)
  assert.equal(refs.FACT_HALF_LIFE_DAYS, 30)
  assert.equal(refs.FACT_STALE_FLOOR, 0.25)
  for (const [days, expected] of [[0, 1], [15, Math.SQRT1_2], [30, 0.5], [60, 0.25], [90, 0.125], [180, 0.015625]]) {
    const entry = { seq: 500, time: stamp(days!), text: 'A stored fact.' }
    const state = refs.factMemoryState(entry, { pins: [], usage: {}, now })
    assert(Math.abs(state.confidence - expected!) < 1e-12)
    assert.equal(state.status, expected! < 0.25 ? 'stale' : 'current')
    const pinned = refs.factMemoryState(entry, { pins: [{ seq: 500, at: stamp(0) }], usage: {}, now })
    assert.equal(pinned.confidence, 1)
    assert.equal(pinned.status, 'current')
    console.log(`PASS age ${days} days: confidence ${state.confidence}; pinned ${pinned.confidence}`)
  }
  console.log('PASS stale rows remain findable, rank after fresh rows before limits, do not refresh on search, and keep every page byte')
} finally {
  rmSync(home, { recursive: true, force: true })
}
