#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MnemeEntry } from '../../src/sessions/mneme/mnemeTopicDocs.js'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-recall-truncation-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { correctMemory, hasSeenFullRow, readMemoryRecord, RECALL_RESULT_CAP_CHARS } = await import(
  '../../src/sessions/mneme/memoryVerbs.js'
)
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.js')
const { docFileName, serializeTopicDoc } = await import('../../src/sessions/mneme/mnemeTopicDocs.js')
const { RecallTool } = await import('../../src/tools/memory/MemoryTools.js')

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
check('the fixture doc is past the result cap', rawDocChars > RECALL_RESULT_CAP_CHARS, `${rawDocChars} chars vs cap ${RECALL_RESULT_CAP_CHARS}`, 'raise the entry count or text length of bigEntries in this file, or check RECALL_RESULT_CAP_CHARS in src/sessions/mneme/memoryVerbs.ts')

section('whole-doc read: rendered under the cap, marking follows the render')
const out = (await RecallTool.call({ read: 'doc:ledger' } as never, {} as never)) as {
  data: { kind: string; found: boolean; content?: string; note?: string }
}
check('the read found the doc', out.data.found === true, JSON.stringify(out.data).slice(0, 120), 'read the doc through readMemoryRecord in src/sessions/mneme/memoryVerbs.ts and the Recall tool in src/tools/memory/MemoryTools.ts')
const block = RecallTool.mapToolResultToToolResultBlockParam(out.data as never, 'toolu_prover') as {
  content: string
}
check('the tool result fits the cap (harness truncation never fires)', block.content.length <= RECALL_RESULT_CAP_CHARS, `${block.content.length} chars`, 'the whole-doc render must stay under RECALL_RESULT_CAP_CHARS: see DOC_RENDER_BUDGET_CHARS and the doc render in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts')
check('the result names the truncation', block.content.includes('TRUNCATED'), (out.data.note ?? '').slice(0, 100), 'the TRUNCATED note is built in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, and must reach the tool result in src/tools/memory/MemoryTools.ts')
check('the result says dropped rows are NOT marked seen', block.content.includes('NOT marked seen'), '', 'the note text in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must say dropped rows are NOT marked seen, and the tool must pass the note into its result')
check('the note names dropped rows by exact id', /DROPPED \d+ line\(s\) carrying \d+ live row\(s\): seq:\d+/.test(out.data.note ?? ''), (out.data.note ?? '').slice(0, 220), 'nameDroppedRows in src/sessions/mneme/memoryVerbs.ts must list each dropped live row as seq:<n>')
check('the note teaches the per-seq unlock read', (out.data.note ?? '').includes('read:"seq:<n>"'), '', 'the truncation note in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must teach read:"seq:<n>"')

const marked = bigEntries.map(e => e.seq).filter(seq => hasSeenFullRow(seq))
const unmarked = bigEntries.map(e => e.seq).filter(seq => !hasSeenFullRow(seq))
check('some head rows are marked seen', marked.length > 0, `${marked.length} marked`, 'the whole-doc read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must mark the rendered rows seen')
check('some tail rows are NOT marked', unmarked.length > 0, `${unmarked.length} unmarked`, 'the whole-doc read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must leave dropped rows unmarked')
const boundary = Math.max(...marked)
check('marking is exactly the rendered prefix (contiguous)', marked.every(s => s <= boundary) && unmarked.every(s => s > boundary), `boundary=${boundary}`, 'marking in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must follow exactly the rows the render kept')
check('the rendered content actually shows the last marked row', block.content.includes(`ledger fact ${String(boundary).padStart(3, '0')}`), '', 'the rows marked seen and the rows rendered in src/sessions/mneme/memoryVerbs.ts disagree')
check('the rendered content does NOT show the first dropped row', !block.content.includes(`ledger fact ${String(boundary + 1).padStart(3, '0')}`), '', 'the rows marked seen and the rows rendered in src/sessions/mneme/memoryVerbs.ts disagree')

section('amend on a dropped row still demands the read')
const tailSeq = 120
check('the probe row was dropped from the render', !hasSeenFullRow(tailSeq), '', 'the whole-doc read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must not mark dropped rows seen')
const blind = correctMemory({ op: 'amend', id: `seq:${tailSeq}`, content: 'ledger fact 120 (amended)', reason: 'prover', session: 'prover' })
check('amend refused with unseen-evidence', blind.ok === false && blind.code === 'unseen-evidence', JSON.stringify(blind).slice(0, 160), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must refuse an amend of a row not seen in full (unseen-evidence)')

section('per-seq read inside the over-budget section: the row alone, whole')
const read = readMemoryRecord(`seq:${tailSeq}`)
check('the read found the row', read.found === true, read.note, 'readMemoryRecord in src/sessions/mneme/memoryVerbs.ts must resolve seq:<n> inside an over-budget section')
check('the content is the full row line', (read.content ?? '').includes('ledger fact 120') && !(read.content ?? '').includes('\n'), `${(read.content ?? '').length} chars`, 'the seq read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must return the one row line whole')
check('the note carries the row breadcrumb', (read.note ?? '').includes('doc:ledger › facts'), read.note, 'the seq read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must carry the doc › section breadcrumb')
check('the target is now marked seen', hasSeenFullRow(tailSeq), '', 'the seq read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must mark the row it returns as seen')
check('a neighbouring dropped row stays unmarked', !hasSeenFullRow(tailSeq - 1), '', 'the seq read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must mark only the row it returns')
const amended = correctMemory({ op: 'amend', id: `seq:${tailSeq}`, content: 'ledger fact 120 (amended)', reason: 'prover', session: 'prover' })
check('the SAME amend now lands', amended.ok === true, JSON.stringify(amended).slice(0, 160), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must accept an amend once hasSeenFullRow holds for the row')

section('one owner for the cap · small docs keep today’s semantics')
check('the tool cap IS the verbs-layer constant', (RecallTool as { maxResultSizeChars?: number }).maxResultSizeChars === RECALL_RESULT_CAP_CHARS, String((RecallTool as { maxResultSizeChars?: number }).maxResultSizeChars), 'maxResultSizeChars of RecallTool in src/tools/memory/MemoryTools.ts must be RECALL_RESULT_CAP_CHARS from src/sessions/mneme/memoryVerbs.ts')
const tiny = readMemoryRecord('doc:tiny')
check('a small whole-doc read carries no truncation note', tiny.found === true && tiny.note === undefined, tiny.note, 'readMemoryRecord in src/sessions/mneme/memoryVerbs.ts must add the truncation note only when the render drops lines')
check('a small whole-doc read marks every live row', [200, 201, 202].every(seq => hasSeenFullRow(seq)), '', 'a whole-doc read in readMemoryRecord, src/sessions/mneme/memoryVerbs.ts, must mark every live row of a doc that fits')

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RECALL-TRUNCATION PROOFS PASS' : `❌ ${failures} RECALL-TRUNCATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
