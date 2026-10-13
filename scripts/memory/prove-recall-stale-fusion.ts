import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'recall-stale-fusion-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { recallQuery } = await import('../../src/mneme/memoryVerbs.ts')
const { searchPointers } = await import('../../src/mneme/mnemePointers.ts')
const { emptyDoc, docFileName } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { readUsage } = await import('../../src/mneme/mnemeUsage.ts')
const now = new Date('2026-10-13T12:00:00.000Z')
const doc = emptyDoc('quartz', 'certificate notes', now.toISOString())
doc.sections = [{ heading: 'notes', entries: [
  ...Array.from({ length: 105 }, (_, i) => ({ seq: i + 1, text: `Quartz certificates deployed after review ${i}.`, source: 'proof', time: '2026-01-01T00:00:00.000Z' })),
  { seq: 106, text: 'The quartz certificate deploying guide is concise.', source: 'proof', time: now.toISOString() },
  { seq: 107, text: 'Amber archives remain offline.', source: 'proof', time: now.toISOString() },
] }]
writeDoc(doc, home)
try {
  const bytes = readFileSync(join(home, docFileName(doc.slug)), 'utf8')
  const result = recallQuery('quartz certificates', { dir: home, now, limit: 2 })
  assert.equal(result.hits[0]?.id, 'seq:106')
  assert.equal(result.hits[1]?.status, 'stale')
  assert.equal(result.hits.length, 2)
  const literal = recallQuery('quartz certificates.*deployed', { dir: home, now, limit: 2 })
  assert(literal.hits.every(hit => hit.id !== 'seq:106'))
  assert.equal(literal.hits.length, 2)
  const pointers = searchPointers('quartz certificates', { dir: home, now, limit: 2, sessions: [] }).pointers
  assert.equal(pointers[0]?.id, 'seq:106')
  assert.deepEqual(Object.keys(pointers[0]!).sort(), ['footnotes', 'id', 'kind', 'title'])
  assert(!pointers[0]!.title.includes('concise'))
  assert(pointers[1]!.title.includes('[stale — not confirmed since 2026-01-01]'))
  assert.deepEqual(readUsage(home), {})
  assert.equal(readFileSync(join(home, docFileName(doc.slug)), 'utf8'), bytes)
  console.log('PASS Recall fuses literal and inflected matches, partitions stale hits before the limit, and preserves explicit pattern matching')
} finally {
  rmSync(home, { recursive: true, force: true })
}
