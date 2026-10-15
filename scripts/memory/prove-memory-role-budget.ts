import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-role-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { renderFrontPage, loadMemoryPrompt } = await import('../../src/mneme/mnemeFrontPage.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const now = '2026-01-01T00:00:00.000Z'
const origin = join(home, 'projects', 'one', 'memory', 'library')
const sibling = join(home, 'projects', 'two', 'memory', 'library')
mkdirSync(origin, { recursive: true });mkdirSync(sibling, { recursive: true })
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({ heading: 'notes', entries: [
  { seq: 1, time: now, source: 'tool:Retain s:source', text: 'Ask before moving a shared vessel.' },
  { seq: 2, time: now, source: 'tool:Retain s:source', text: 'Never claim a berth was inspected without checking.' },
  { seq: 3, time: now, source: 'tool:Retain s:source', text: 'The lead prepares the launch register.' },
  { seq: 4, time: now, source: 'tool:Retain s:source', text: 'Keep the unclassified rule visible.' },
] })
const pins = doc.sections[0]!.entries.map(row => ({ seq: row.seq, at: now, asked: true, ...(row.seq < 4 ? { applicability: { scope: row.seq < 3 ? 'global' : 'project', ...(row.seq < 3 ? { purpose: row.seq === 1 ? 'safety' : 'honesty' } : { role: 'main' }), directive: { messageId: `operator-${row.seq}`, text: `Remember this as a ${row.seq === 1 ? 'global safety rule' : row.seq === 2 ? 'global honesty rule' : 'rule only for the main thread'}: ${row.text}` } } } : {}) }))
writeFileSync(join(origin, 'topic-harbour.md'), serializeTopicDoc(doc))
writeFileSync(join(origin, 'pins.json'), JSON.stringify({ version: 1, pins }))
const before = readFileSync(join(origin, 'pins.json'), 'utf8')
try {
  const empty = renderFrontPage({ dir: sibling, topics: [], archives: [], pins: [], usage: {}, now: new Date(now) }).text
  assert.equal(empty.trim(), 'Memory: empty.')
  const child = renderFrontPage({ dir: origin, topics: [doc], archives: [], pins: readPins(origin), usage: {}, now: new Date(now), role: 'child' } as never).text
  assert.ok(child.includes('shared vessel') && child.includes('without checking'))
  assert.ok(child.includes('unclassified rule'), 'unknown scope keeps conservative visibility')
  assert.ok(!child.includes('launch register'), 'a source-supported main-only rule is not projected into a child')
  const global = loadMemoryPrompt({ dir: sibling } as never) ?? ''
  assert.ok(global.includes('shared vessel') && global.includes('without checking'), 'sibling receives both explicitly global safety/honesty pins')
  assert.ok(!global.includes('launch register') && !global.includes('unclassified rule'), 'project and unknown pins never become global')
  assert.ok(global.includes(origin), 'source library identity accompanies the global words')
  assert.equal(readFileSync(join(origin, 'pins.json'), 'utf8'), before)
  console.log(`PASS empty 1 line; global 2/2; child unrelated 0; unknown preserved; bytes empty=${Buffer.byteLength(empty)} child=${Buffer.byteLength(child)} sibling=${Buffer.byteLength(global)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
