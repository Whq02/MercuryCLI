;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switchboard-mirror-home-'))
process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR

let failures = 0
const mirrorFailureHint = (label: string): string => {
  if (/plate/.test(label)) return 'change attachedPlateName in src/screen/messages/TranscriptNameplate.tsx'
  if (/projection|retired-format/.test(label)) return 'change foldWorkerRecord in src/sessions/transcripts/mirrorRecord.ts (re-exported by src/screen/concourse/workerTranscriptFold.ts)'
  return 'change mergeFoldedMessages in src/screen/concourse/workerTranscriptFold.ts (or foldWorkerRecord, which gives both revisions one uuid)'
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? '' : `${detail ? `${detail} — ` : ''}${mirrorFailureHint(label)}`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

console.log('LAW 2 — the word-ban (mirror-agent-word):')
const { attachedPlateName, userHandle } = await import('../../src/screen/messages/TranscriptNameplate.js')
check("attachedPlateName maps 'agent' → 'Mercury'", attachedPlateName('agent') === 'Mercury')
check("attachedPlateName plates 'coordinator' as 'Coordinator'", attachedPlateName('coordinator') === 'Coordinator')
check(
  "attachedPlateName plates the operator as the handle",
  attachedPlateName('user') === userHandle() && attachedPlateName('user').length > 0,
)
check(
  'no painted plate contains the banned word',
  (['agent', 'coordinator', 'user'] as const).every(a => !/\bagent\b/i.test(attachedPlateName(a))),
)

const { foldWorkerRecord } = await import('../../src/screen/concourse/workerTranscriptFold.js')
const { entryToRecord } = await import('../../src/sessions/fabric/entryCodec.js')
const { ordinalOf } = await import('../../src/sessions/fabric/ordinal.js')
let mgOrd = 0
const mgCtx = {
  sessionId: '00000000-aaaa-4000-8000-00000000mg01' as never,
  nextOrdinal: () => ordinalOf(++mgOrd) as never,
  observedAt: '2026-08-15T00:00:00Z',
  source: { channel: 'sdk' } as const,
}
const folded = foldWorkerRecord(
  entryToRecord(
    { type: 'user', uuid: 'u-1', timestamp: '2026-08-15T00:00:00Z', message: { role: 'user', content: 'hi' } },
    mgCtx as never,
  ) as unknown,
  'fallback-0',
) as { uuid?: string } | null
check('the pure projection passes a user record', folded !== null && folded.uuid === 'u-1')
check(
  'the pure projection rejects a metadata record',
  foldWorkerRecord(entryToRecord({ type: 'summary', summary: 's' }, mgCtx as never) as unknown, 'fb') === null,
)
check(
  'a retired-format line is never rendered as conversation',
  foldWorkerRecord({ type: 'user', uuid: 'u-2', message: { role: 'user', content: 'other era' } }, 'fb2') === null,
)

console.log('LAW 6 — the revision collapse (AGENTDIALS C3: last-write-wins per recordId):')
const { mergeFoldedMessages } = await import('../../src/screen/concourse/workerTranscriptFold.js')
const revisionEntry = (stopReason: string | null, text: string): unknown =>
  entryToRecord(
    {
      type: 'assistant',
      uuid: 'a-rev-1',
      timestamp: '2026-08-15T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason },
    } as never,
    mgCtx as never,
  ) as unknown
const snap = foldWorkerRecord(revisionEntry(null, 'Finished count'), 'fb-r0') as { uuid: string } | null
const fin = foldWorkerRecord(revisionEntry('end_turn', 'Finished counting'), 'fb-r1') as { uuid: string } | null
const other = foldWorkerRecord(
  entryToRecord(
    { type: 'user', uuid: 'u-before', timestamp: '2026-08-15T00:00:00Z', message: { role: 'user', content: 'count' } },
    mgCtx as never,
  ) as unknown,
  'fb-r2',
) as { uuid: string } | null
check('the revision fixture projects (snapshot + final share one recordId)', snap !== null && fin !== null && other !== null && snap.uuid === fin.uuid)
if (snap !== null && fin !== null && other !== null) {
  const text = (m: unknown): string =>
    String(((m as { message?: { content?: Array<{ text?: string }> } }).message?.content ?? [])[0]?.text ?? '')
  check('control: the naive concat double-paints the revision pair', [other, snap, fin].length === 3)
  const cold = mergeFoldedMessages([], [other, snap, fin])
  check('the cold fold paints the pair as ONE message', cold.length === 2, `painted ${cold.length}`)
  check('…wearing the FINAL revision', text(cold[1]) === 'Finished counting', text(cold[1]))
  const partial = mergeFoldedMessages([], [other, snap])
  check('the streaming partial still paints (the collapse never suppresses)', partial.length === 2 && text(partial[1]) === 'Finished count')
  const settled = mergeFoldedMessages(partial, [fin])
  check('the final REPLACES at the same slot — position kept, count kept', settled.length === 2 && text(settled[1]) === 'Finished counting' && settled[0] === partial[0])
  check('distinct rows still append in order', mergeFoldedMessages([other], [snap]).length === 2)
}

console.log(
  failures === 0 ? '\nprove-mirror-grammar: ALL LAWS HOLD' : `\nprove-mirror-grammar: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
