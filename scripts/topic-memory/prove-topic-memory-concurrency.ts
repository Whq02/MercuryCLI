#!/usr/bin/env bun
// prove-topic-memory-concurrency — the no-data-loss floor under concurrent writers
// (the self-review fix that replaced read-then-unlink with rename-first
// consumption + an exclusive consolidator lock):
//
//   §1 crash recovery: a stale consuming-* file (a consolidator died mid-run)
//      is ABSORBED into the next batch together with fresh rows — no row lost.
//   §2 the lock: a held .consolidate.lock makes a second consolidator back
//      off with the buffer untouched; a STALE lock (> 5 min) is stolen.
//   §3 refusal restores: consumed rows return to CURRENT byte-complete when
//      the draft is refused (validator proofs assert the count; this asserts
//      the CONTENT).
//   §4 rows appended between consolidations land in a FRESH current.jsonl and
//      survive the previous batch's cleanup (the exact race the fix closes).
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

const { appendObservation, readBuffer } = await import('../../src/memdir/mnemeBuffer.ts')
const { listTopicDocs, maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 crash recovery: stale consuming-* absorbed, nothing lost')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-cc1-'))
  mkdirSync(dir, { recursive: true })
  // A consolidator that died after renaming but before applying:
  writeFileSync(
    join(dir, 'consuming-999-abc.jsonl'),
    JSON.stringify({ ts: '2026-07-06T00:00:00Z', source: 'crashed-run', text: 'orphaned row', topicHint: 'recovery' }) + '\n',
    'utf8',
  )
  appendObservation({ text: 'fresh row', source: 'proof', topicHint: 'recovery' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('consolidated', r.consolidated, r.reason)
  check('both rows landed', r.entries === 2, `${r.entries}`)
  const doc = listTopicDocs(dir).find(d => d.slug === 'recovery')!
  const texts = doc.sections.flatMap(s => s.entries).map(e => e.text)
  check('orphaned row recovered', texts.includes('orphaned row'), texts.join(' | '))
}

section('§2 the consolidator lock: back-off + stale steal')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-cc2-'))
  appendObservation({ text: 'a row', source: 'proof' }, dir)
  mkdirSync(join(dir, '.consolidate.lock'))
  const held = maybeConsolidate({ force: true, dir })
  check('held lock ⇒ back-off', !held.consolidated && held.reason.includes('lock held'), held.reason)
  check('buffer untouched on back-off', readBuffer(dir).length === 1)
  // Age the lock past the staleness window — a crashed holder.
  const old = (Date.now() - 6 * 60 * 1000) / 1000
  utimesSync(join(dir, '.consolidate.lock'), old, old)
  const stolen = maybeConsolidate({ force: true, dir })
  check('stale lock stolen, consolidation proceeds', stolen.consolidated, stolen.reason)
}

section('§3 refusal restores CONTENT, not just count')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-cc3-'))
  appendObservation({ text: 'precious observation', source: 'proof', topicHint: 't' }, dir)
  const before = readFileSync(join(dir, 'current.jsonl'), 'utf8')
  const r = maybeConsolidate({ force: true, dir, rewriter: () => ({ blocks: [] }) }) // drops everything
  check('lossy draft refused', !r.consolidated && r.reason.includes('refused'), r.reason)
  const after = readFileSync(join(dir, 'current.jsonl'), 'utf8')
  check('buffer bytes restored', after === before)
  check('restored rows consolidate fine afterwards', maybeConsolidate({ force: true, dir }).consolidated)
}

section('§4 rows appended after a batch survive its cleanup')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-cc4-'))
  appendObservation({ text: 'batch one row', source: 'proof', topicHint: 't' }, dir)
  check('batch one lands', maybeConsolidate({ force: true, dir }).consolidated)
  appendObservation({ text: 'late arrival', source: 'proof', topicHint: 't' }, dir)
  check('late arrival still buffered', readBuffer(dir).some(r => r.text === 'late arrival'))
  const r2 = maybeConsolidate({ force: true, dir })
  check('late arrival consolidates in batch two', r2.consolidated && r2.entries === 1)
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MNEME CONCURRENCY PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MNEME CONCURRENCY PROOFS PASS')
