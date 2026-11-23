#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '../../src/sessions/mneme/types.js'
const dir = mkdtempSync(join(tmpdir(), 'recall-session-intent-'))
process.env.MERCURY_CONFIG_DIR = join(dir, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { emptyDoc, serializeTopicDoc } = await import('../../src/sessions/mneme/mnemeTopicDocs.js')
const { searchPointers } = await import('../../src/sessions/mneme/mnemePointers.js')
const now = new Date().toISOString()
const doc = emptyDoc('sessions', 'session records', now)
doc.sections.push({ heading: 'notes', entries: [{ seq: 1, time: now, source: 'test', text: 'The session handoff notes include session policy and history.' }] })
writeFileSync(join(dir, 'topic-sessions.md'), serializeTopicDoc(doc))
const session: LedgerEntry = { ordinal: 1, sessionId: 'intent-session', startedAt: now, endedAt: now, engines: [], rulings: [], retained: [], corrected: [], files: [], outcome: 'completed', handoff: { at: now, text: 'The session handoff notes include session policy and history.' } }
const INTENT_FIX_HINT = 'fix the session-subject ranking in searchPointers in src/sessions/mneme/mnemePointers.ts so an explicit session or handoff query puts the ledger pointer first and incidental session words keep the fact first'
try {
  for (const query of ['session handoff', 'handoff notes', 'session history', 'last session', 'the latest handoff', 'show the session handoff', 'what did the last session do', 'what did the previous session do', 'how did the last session end']) {
    assert.equal(searchPointers(query, { dir, sessions: [session], limit: 1 }).pointers[0]?.id, 'ledger:1', `${query} | expected the ledger:1 pointer first | ${INTENT_FIX_HINT}`)
  }
  for (const query of ['session policy', 'what is our session policy', 'why does a session handoff include policy']) {
    assert.equal(searchPointers(query, { dir, sessions: [session], limit: 1 }).pointers[0]?.id, 'seq:1', `${query} | expected the seq:1 fact first | ${INTENT_FIX_HINT}`)
  }
  console.log('PASS explicit session subjects precede facts; incidental session words do not')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
