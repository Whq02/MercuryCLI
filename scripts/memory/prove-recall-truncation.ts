#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-recall-truncation.ts
//  PROOF (spec 06 C4 edge, PV finding N2): seen-marking never outruns what
//  the Recall tool actually rendered.
//    · a >40k-char topic doc read whole is cut at a LINE boundary under the
//      tool's result cap: rendered rows are marked seen, rows past the cut
//      are NOT, and the truncation note NAMES what it dropped (counts +
//      exact seq ids) plus the per-seq read that unlocks each;
//    · Correct{amend} on a dropped row still refuses with unseen-evidence;
//      after the per-seq read, the SAME amend lands;
//    · the per-seq read inside an over-budget section renders the row ALONE
//      (full evidence, no clipped-section lie) and marks no neighbours;
//    · the tool's maxResultSizeChars and the verbs-layer budget share ONE
//      owning constant, and a small doc keeps today's semantics untouched.
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MnemeEntry } from '../../src/memdir/mnemeTopicDocs.js'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-recall-truncation-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_MNEME = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { correctMemory, hasSeenFullRow, readMemoryRecord, RECALL_RESULT_CAP_CHARS } = await import(
  '../../src/memdir/memoryVerbs.js'
)
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')
const { docFileName, serializeTopicDoc } = await import('../../src/memdir/mnemeTopicDocs.js')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')

// ── fixture: one topic doc, ONE section, far past the 40k render cap ───────
const now = new Date().toISOString()
const bigEntries: MnemeEntry[] = Array.from({ length: 120 }, (_, i) => ({
  text: `ledger fact ${String(i + 1).padStart(3, '0')} — ${'x'.repeat(380)}`,
  seq: i + 1,
  time: now,
  source: 'prover',
}))
const bigDoc = {
  id: 'topic-ledger',
  slug: 'ledger',
  summary: 'the truncation corpus',
  tokenCount: 0,
  created: now,
  updated: now,
  updateLog: ['seeded by prove-recall-truncation'],
  sections: [{ heading: 'facts', entries: bigEntries }],
  history: [],
}
const tinyDoc = {
  id: 'topic-tiny',
  slug: 'tiny',
  summary: 'the small control doc',
  tokenCount: 0,
  created: now,
  updated: now,
  updateLog: ['seeded by prove-recall-truncation'],
  sections: [
    {
      heading: 'facts',
      entries: [200, 201, 202].map(seq => ({ text: `tiny fact ${seq}`, seq, time: now, source: 'prover' })),
    },
  ],
  history: [],
}
mkdirSync(mnemeLibraryDir(), { recursive: true })
writeFileSync(join(mnemeLibraryDir(), docFileName('ledger')), serializeTopicDoc(bigDoc))
writeFileSync(join(mnemeLibraryDir(), docFileName('tiny')), serializeTopicDoc(tinyDoc))
const rawDocChars = serializeTopicDoc(bigDoc).length
check('the fixture doc is past the result cap', rawDocChars > RECALL_RESULT_CAP_CHARS, `${rawDocChars} chars vs cap ${RECALL_RESULT_CAP_CHARS}`)

section('whole-doc read: rendered under the cap, marking follows the render')
const out = (await RecallTool.call({ read: 'doc:ledger' } as never, {} as never)) as {
  data: { kind: string; found: boolean; content?: string; note?: string }
}
check('the read found the doc', out.data.found === true, JSON.stringify(out.data).slice(0, 120))
const block = RecallTool.mapToolResultToToolResultBlockParam(out.data as never, 'toolu_prover') as {
  content: string
}
check('the tool result fits the cap (harness truncation never fires)', block.content.length <= RECALL_RESULT_CAP_CHARS, `${block.content.length} chars`)
check('the result names the truncation', block.content.includes('TRUNCATED'), (out.data.note ?? '').slice(0, 100))
check('the result says dropped rows are NOT marked seen', block.content.includes('NOT marked seen'))
check('the note names dropped rows by exact id', /DROPPED \d+ line\(s\) carrying \d+ live row\(s\): seq:\d+/.test(out.data.note ?? ''), (out.data.note ?? '').slice(0, 220))
check('the note teaches the per-seq unlock read', (out.data.note ?? '').includes('read:"seq:<n>"'))

const marked = bigEntries.map(e => e.seq).filter(seq => hasSeenFullRow(seq))
const unmarked = bigEntries.map(e => e.seq).filter(seq => !hasSeenFullRow(seq))
check('some head rows are marked seen', marked.length > 0, `${marked.length} marked`)
check('some tail rows are NOT marked', unmarked.length > 0, `${unmarked.length} unmarked`)
const boundary = Math.max(...marked)
check('marking is exactly the rendered prefix (contiguous)', marked.every(s => s <= boundary) && unmarked.every(s => s > boundary), `boundary=${boundary}`)
check('the rendered content actually shows the last marked row', block.content.includes(`ledger fact ${String(boundary).padStart(3, '0')}`))
check('the rendered content does NOT show the first dropped row', !block.content.includes(`ledger fact ${String(boundary + 1).padStart(3, '0')}`))

section('amend on a dropped row still demands the read')
const tailSeq = 120
check('the probe row was dropped from the render', !hasSeenFullRow(tailSeq))
const blind = correctMemory({ op: 'amend', id: `seq:${tailSeq}`, content: 'ledger fact 120 (amended)', reason: 'prover', session: 'prover' })
check('amend refused with unseen-evidence', blind.ok === false && blind.code === 'unseen-evidence', JSON.stringify(blind).slice(0, 160))

section('per-seq read inside the over-budget section: the row alone, whole')
const read = readMemoryRecord(`seq:${tailSeq}`)
check('the read found the row', read.found === true, read.note)
check('the content is the full row line', (read.content ?? '').includes('ledger fact 120') && !(read.content ?? '').includes('\n'), `${(read.content ?? '').length} chars`)
check('the note says only the row is shown (section over budget)', (read.note ?? '').includes('only the row is shown'), read.note)
check('the target is now marked seen', hasSeenFullRow(tailSeq))
check('a neighbouring dropped row stays unmarked', !hasSeenFullRow(tailSeq - 1))
const amended = correctMemory({ op: 'amend', id: `seq:${tailSeq}`, content: 'ledger fact 120 (amended)', reason: 'prover', session: 'prover' })
check('the SAME amend now lands', amended.ok === true, JSON.stringify(amended).slice(0, 160))

section('one owner for the cap · small docs keep today’s semantics')
check('the tool cap IS the verbs-layer constant', (RecallTool as { maxResultSizeChars?: number }).maxResultSizeChars === RECALL_RESULT_CAP_CHARS, String((RecallTool as { maxResultSizeChars?: number }).maxResultSizeChars))
const tiny = readMemoryRecord('doc:tiny')
check('a small whole-doc read carries no truncation note', tiny.found === true && tiny.note === undefined, tiny.note)
check('a small whole-doc read marks every live row', [200, 201, 202].every(seq => hasSeenFullRow(seq)))

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* best effort */
}
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RECALL-TRUNCATION PROOFS PASS' : `❌ ${failures} RECALL-TRUNCATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
