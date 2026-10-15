#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { LedgerEntry } from '../../src/mneme/types.js'

const scratch = mkdtempSync(join(tmpdir(), 'recall-order-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { searchPointers, ledgerPointers } = await import('../../src/mneme/mnemePointers.js')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { retainItems } = await import('../../src/mneme/memoryVerbs.js')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { openEntry, recordHandoff, closeEntry } = await import('../../src/mneme/ledger.js')
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const now = '2026-10-15T12:00:00.000Z'
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const doc = emptyDoc('facts', 'facts', now)
doc.sections.push({ heading: 'notes', entries: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, text: `question${i + 1} deployment policy`, time: now, source: 'tool:Retain s:proof' })) })
writeFileSync(join(dir, 'topic-facts.md'), serializeTopicDoc(doc))
const session: LedgerEntry = { ordinal: 1, sessionId: 'proof-session', startedAt: now, endedAt: now, engines: [], rulings: [], retained: [], corrected: [], files: ['deployment'], outcome: 'completed', handoff: { at: now, text: doc.sections[0]!.entries.map(e => e.text).join(' ') } }
const sessions = [session, { ...session, ordinal: 2, endedAt: null }, { ...session, ordinal: 3, handoff: null }]
try {
  let preempted = 0
  for (let i = 1; i <= 25; i++) {
    const result = searchPointers(`question${i}`, { dir, sessions, now: new Date(now), limit: 1 })
    if (result.pointers[0]?.id.startsWith('ledger:')) preempted++
    if (!result.pointers[0]?.id.startsWith('ledger:')) assert.ok(result.found >= 2)
  }
  console.log(`ledger-before-fact ${preempted}/25`)
  assert.equal(preempted, 0)
  assert.deepEqual(ledgerPointers('deployment', sessions).map(p => p.id), ['ledger:1'])
  assert.equal(searchPointers('show the handoff for question1', { dir, sessions }).pointers[0]?.id, 'ledger:1')
  assert.equal(searchPointers('which session handled deployment', { dir, sessions }).pointers[0]?.id, 'ledger:1')
  assert.equal(searchPointers('ledger deployment', { dir, sessions }).pointers[0]?.id, 'ledger:1')
  assert.equal(searchPointers('question1 session policy', { dir, sessions, limit: 1 }).pointers[0]?.kind, 'fact')
  assert.equal(searchPointers('deployment', { dir: join(scratch, 'empty'), sessions }).pointers[0]?.id, 'ledger:1')
  assert.equal(searchPointers('nonmatchingword', { dir, sessions }).elidable, true)
  retainItems([{ content: 'pendingquartz decision', topic: 'facts' }], { session: 'proof-session' })
  assert.ok(searchPointers('pendingquartz', { dir, sessions: [{ ...session, handoff: { at: now, text: 'pendingquartz decision' } }], limit: 1 }).pointers[0]?.id.startsWith('pending:'))
  const key = mnemeProjectKey()
  openEntry(key, { sessionId: 'proof-session', model: 'proof-engine' })
  recordHandoff(key, 'proof-session', 'question1 deployment policy')
  closeEntry(key, 'proof-session', { outcome: 'completed' })
  const output = await RecallTool.call({ query: 'question1', limit: 1 }, {} as never) as { data: { pointers: { id: string }[] } }
  assert.equal(output.data.pointers[0]?.id, 'seq:1')
  console.log('PASS fact-first ordering, intent, pending, limits, fallback, filtered sessions and public Recall')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
