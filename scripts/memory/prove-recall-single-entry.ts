#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'recall-entry-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { readMemoryRecord, hasSeenFullRow } = await import('../../src/mneme/memoryVerbs.js')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = '2026-10-15T12:00:00.000Z'
const doc = emptyDoc('reading', 'single entry controls', now)
doc.sections.push({ heading: 'decisions', entries: Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, time: now, source: 'tool:Retain s:reader', text: `entry ${i + 1} ${'quartz '.repeat(95)}` })) })
doc.history.push({ seq: 21, time: now, source: 'tool:Retain s:reader', text: 'earlier decision', supersededBy: 1 })
writeFileSync(join(dir, 'topic-reading.md'), serializeTopicDoc(doc))
try {
  const read = readMemoryRecord('seq:1', dir)
  console.log(`page bytes ${Buffer.byteLength(serializeTopicDoc(doc))}; read bytes ${Buffer.byteLength(read.content ?? '')}`)
  assert.equal((read.content?.match(/<seq=/g) ?? []).length, 1)
  assert.ok(read.content?.includes(doc.sections[0]!.entries[0]!.text))
  assert.ok(read.note?.includes('doc:reading › decisions'))
  assert.equal(hasSeenFullRow(1), true)
  assert.equal(hasSeenFullRow(2), false)
  const pair = await Promise.all([1, 2].map(async seq => {
    const out = await RecallTool.call({ read: `seq:${seq}` }, {} as never) as { data: { content: string } }
    return out.data.content
  }))
  assert.equal(pair.join('\n').match(/<seq=/g)?.length, 2)
  assert.ok(pair.every((text, i) => text.includes(`entry ${i + 1} `)))
  assert.equal(hasSeenFullRow(3), false)
  const history = readMemoryRecord('seq:21', dir)
  assert.equal(history.footnotes?.supersededBy, 'seq:1')
  assert.ok(history.note?.includes('doc:reading › history'))
  assert.ok(!history.content?.includes('entry 2 '))
  assert.equal(readMemoryRecord('doc:reading', dir).content?.match(/<seq=/g)?.length, 21)
  assert.equal(hasSeenFullRow(3), true)
  const giant = emptyDoc('giant', 'large row', now)
  giant.sections.push({ heading: 'notes', entries: [{ seq: 100, time: now, source: 'test', text: 'x'.repeat(40001) }] })
  writeFileSync(join(dir, 'topic-giant.md'), serializeTopicDoc(giant))
  assert.ok(readMemoryRecord('seq:100', dir).note?.includes('amend stays locked'))
  assert.equal(hasSeenFullRow(100), false)
  console.log('PASS single entry, breadcrumb, exact evidence, same-page pair, history, explicit page read and oversized lock')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
