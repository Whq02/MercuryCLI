#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '../../src/mneme/types.js'
const dir = mkdtempSync(join(tmpdir(), 'recall-session-intent-'))
process.env.MERCURY_CONFIG_DIR = join(dir, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.js')
const { searchPointers } = await import('../../src/mneme/mnemePointers.js')
const now = new Date().toISOString()
const doc = emptyDoc('sessions', 'session records', now)
doc.sections.push({ heading: 'notes', entries: [{ seq: 1, time: now, source: 'test', text: 'The session handoff notes include session policy and history.' }] })
writeFileSync(join(dir, 'topic-sessions.md'), serializeTopicDoc(doc))
const session: LedgerEntry = { ordinal: 1, sessionId: 'intent-session', startedAt: now, endedAt: now, engines: [], rulings: [], retained: [], corrected: [], files: [], outcome: 'completed', handoff: { at: now, text: 'The session handoff notes include session policy and history.' } }
try {
  for (const query of ['session handoff', 'handoff notes', 'session history', 'last session', 'the latest handoff', 'show the session handoff']) {
    assert.equal(searchPointers(query, { dir, sessions: [session], limit: 1 }).pointers[0]?.id, 'ledger:1', query)
  }
  for (const query of ['session policy', 'what is our session policy', 'why does a session handoff include policy']) {
    assert.equal(searchPointers(query, { dir, sessions: [session], limit: 1 }).pointers[0]?.id, 'seq:1', query)
  }
  console.log('PASS explicit session subjects precede facts; incidental session words do not')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
