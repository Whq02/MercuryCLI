#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-transcript-read-accounting.ts — ER-4: the
//  transcript read path accounts for every input line and classifies shape.
//
//  The guarded class: a parseJSONL silently skipping
//  malformed lines (a corrupted transcript shrinks with no signal) and
//  compile-time-casting every value (message:42 flows typed into resume).
//
//  The fixed contract this prover pins (fabric/transcriptDecode — the
//  validating seam wired into loadTranscriptFile):
//    §A TOTAL ACCOUNTING — entries + malformed + invalid == input lines;
//       malformed lines are position-classified, never silently dropped.
//    §B VALIDATION BOUNDARY — a record whose payload violates the contract
//       is classified invalid, never cast through as an Entry; a stray
//       non-record object inside a record file is classified, never folded.
//    §C HAPPY-PATH SPEED — a clean buffer takes the parseJSONL fast path
//       (no per-line rescan): malformed classification only runs when the
//       accounting disagrees.
//    §D THE FORMAT REFUSAL — a file whose first parseable line is not a
//       record is refused WHOLE with the one honest line.
// ============================================================================
const { decodeTranscriptBuffer, TRANSCRIPT_FORMAT_REFUSAL } = await import(
  '../../src/fabric/transcriptDecode.js'
)
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

let n = 0
const ctx = {
  sessionId: '00000000-aaaa-4000-8000-000000000001' as never,
  nextOrdinal: () => ordinalOf(++n) as never,
  observedAt: '2026-08-01T10:00:00.000Z',
  source: { channel: 'sdk' } as const,
}
const recordLine = (entry: Record<string, unknown>): string =>
  JSON.stringify(entryToRecord(entry, ctx as never))

const valid = recordLine({
  type: 'user',
  uuid: '00000000-0000-4000-8000-000000000001',
  message: { role: 'user', content: 'hello' },
  timestamp: '2026-08-01T10:00:00.000Z',
})
const malformed = '{ this is not json'
// A record whose payload violates the contract (content: 42) — the
// validation boundary classifies it; nothing casts through.
const wrongShape = (() => {
  const rec = JSON.parse(valid) as { payload: { content: unknown } }
  rec.payload.content = 42
  return JSON.stringify(rec)
})()
const input = [valid, malformed, wrongShape].join('\n') + '\n'

section('§A total accounting — no silent shrink')
{
  const d = decodeTranscriptBuffer<Record<string, unknown>>(input)
  check('entries + malformed + invalid == input lines', d.entries.length + d.malformed.length + d.invalid.length === d.totalLines && d.totalLines === 3,
    `entries=${d.entries.length} malformed=${d.malformed.length} invalid=${d.invalid.length} total=${d.totalLines}`)
  check('the malformed line is position-classified', d.malformed.length === 1 && d.malformed[0]!.line === 2, JSON.stringify(d.malformed))
  check('the valid entry survives', d.entries.length === 1 && (d.entries[0] as { type?: string }).type === 'user')
}

section('§B shape floor — cast-through closed')
{
  const d = decodeTranscriptBuffer<Record<string, unknown>>(input)
  check('content:42 is classified invalid, not cast through', d.invalid.length === 1 && d.invalid[0]!.kind === 'record-invalid' && d.invalid[0]!.reason.includes('content'),
    JSON.stringify(d.invalid))
  const strayObject = decodeTranscriptBuffer<Record<string, unknown>>(valid + '\n' + JSON.stringify({ note: 'not a record' }) + '\n')
  check('a stray non-record object is classified, never folded', strayObject.invalid.length === 1 && strayObject.invalid[0]!.kind === 'not-a-record' && strayObject.entries.length === 1,
    JSON.stringify(strayObject.invalid))
}

section('§C clean buffers take the fast path (Buffer + string forms)')
{
  const clean = Array.from({ length: 500 }, (_, i) => recordLine({ type: 'tag', tag: `t${i}`, sessionId: 's' })).join('\n') + '\n'
  for (const form of [clean, Buffer.from(clean)] as const) {
    const d = decodeTranscriptBuffer<Record<string, unknown>>(form)
    check(`clean ${Buffer.isBuffer(form) ? 'Buffer' : 'string'}: 500/500 entries, zero classified`, d.entries.length === 500 && d.malformed.length === 0 && d.invalid.length === 0 && d.totalLines === 500)
  }
  // CRLF + blank-line tolerance: blank lines never count against accounting.
  const gappy = valid + '\n\n' + recordLine({
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000002',
    message: { role: 'user', content: 'again' },
    timestamp: '2026-08-01T10:00:01.000Z',
  }) + '\n'
  const d = decodeTranscriptBuffer<Record<string, unknown>>(gappy)
  check('blank lines excluded from the accounting total', d.totalLines === 2 && d.entries.length === 2, `total=${d.totalLines}`)
}

section('§D the format refusal — one honest line, whole file')
{
  const alien = JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-00000000000a', message: { role: 'user', content: 'other era' } })
  const d = decodeTranscriptBuffer<Record<string, unknown>>(alien + '\n' + valid + '\n')
  check('a non-record first line refuses the WHOLE file', d.refusal === TRANSCRIPT_FORMAT_REFUSAL && d.entries.length === 0, String(d.refusal))
  const arrays = decodeTranscriptBuffer<Record<string, unknown>>('"just a string"\n[1,2,3]\n')
  check('non-object lines classified (not a format verdict)', arrays.invalid.length === 2 && arrays.entries.length === 0 && arrays.refusal === undefined)
  const tornHead = decodeTranscriptBuffer<Record<string, unknown>>('{ torn head line\n' + valid + '\n')
  check('a torn head never decides the format — record lines still decode', tornHead.refusal === undefined && tornHead.entries.length === 1 && tornHead.malformed.length === 1)
}

console.log(failures === 0 ? '\n ✅ TRANSCRIPT READ ACCOUNTING PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
