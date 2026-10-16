#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const scratch = mkdtempSync(join(tmpdir(), 'recall-contract-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const P = await import('../../src/mneme/mnemePointers.js')
const V = await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { parseEntryLine } = await import('../../src/mneme/mnemeTopicDocs.js')
const dir = mnemeLibraryDir()
const text = 'The portable clock inspection uses the quartz checklist.'
const witness = (content: string) => createHash('sha256').update(content).digest('hex')
try {
  assert.equal(typeof P.memoryPointerForId, 'function', 'one shared exact-record pointer builder')
  const stored = V.retainItems([{ content: text, topic: 'checks' }], { session: 'contract-session' })[0]!
  assert.equal(stored.status, 'stored')
  if (stored.status !== 'stored') throw new Error('not stored')
  const id = stored.id
  const pointer = P.memoryPointerForId(id, { dir, query: 'quartz checklist' })!
  assert.ok(pointer)
  assert.equal(pointer.id, id)
  assert.equal(pointer.source?.kind, 'pending')
  assert.equal(pointer.freshness?.status, 'unconsolidated')
  assert.deepEqual(pointer, P.searchPointers('quartz checklist', { dir, sessions: [] }).pointers.find(p => p.id === id))
  assert.ok(!JSON.stringify(pointer).includes(text))
  const opened = V.readMemoryRecord(id, dir)
  assert.ok(opened.content?.startsWith(text + ' [unconsolidated,'))
  const saved = JSON.parse(JSON.stringify(pointer))
  const child = spawnSync(process.execPath, ['-e', `globalThis.MACRO={VERSION:'1.0.0'}; const P=await import(${JSON.stringify(join(import.meta.dir, '../../src/mneme/mnemePointers.ts'))}); const V=await import(${JSON.stringify(join(import.meta.dir, '../../src/mneme/memoryVerbs.ts'))}); console.log(JSON.stringify({pointer:P.memoryPointerForId(${JSON.stringify(id)},{dir:${JSON.stringify(dir)},query:'quartz checklist'}),content:V.readMemoryRecord(${JSON.stringify(id)},${JSON.stringify(dir)}).content}));`], { encoding: 'utf8', env: process.env })
  assert.equal(child.status, 0, child.stderr)
  const restarted = JSON.parse(child.stdout.trim())
  assert.deepEqual(restarted.pointer, saved)
  assert.equal(witness(restarted.content), witness(opened.content!))
  assert.equal(maybeConsolidate({ dir, force: true }).consolidated, true)
  const seqId = V.consolidatedIdOf(id, dir)!
  assert.ok(seqId.startsWith('seq:'))
  assert.equal(P.memoryPointerForId(id, { dir }), null)
  const fact = P.memoryPointerForId(seqId, { dir, query: 'quartz checklist' })!
  assert.equal(fact.source?.kind, 'entry')
  assert.deepEqual(fact, P.searchPointers('quartz checklist', { dir, sessions: [] }).pointers.find(p => p.id === seqId))
  assert.equal(parseEntryLine(V.readMemoryRecord(seqId, dir).content!)?.text, text)
  const corrected = V.correctMemory({ id: seqId, op: 'supersede', content: 'The portable clock inspection uses the amber checklist.', reason: 'changed checklist', session: 'contract-session' }, dir)
  assert.equal(corrected.ok, true)
  if (!corrected.ok || 'draft' in corrected) throw new Error('correction did not consolidate')
  assert.equal(P.memoryPointerForId(seqId, { dir })?.footnotes.supersededBy, `seq:${corrected.newSeq}`)
  const next = V.readMemoryRecord(`seq:${corrected.newSeq}`, dir)
  assert.notEqual(witness(next.content!), witness(opened.content!))
  assert.equal(P.memoryPointerForId('seq:99999', { dir }), null)
  assert.equal(P.memoryPointerForId('not-a-record', { dir }), null)
  console.log('PASS shared pointer, persisted read-back, restart, consolidation identity, supersession and changed-content witness')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
