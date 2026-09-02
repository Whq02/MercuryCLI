#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-seat-line-adversarial.ts — CONTENT-SHAPED frames
//  against the seat's line dispatch (delivery-verifier lane).
//
//  onSeatLine dispatches worker stdout lines by BARE SUBSTRING. The
//  escaped-quote argument its comments make ("inside a JSON string value a
//  double quote is escaped") is sound for STRING CONTENT — but a nested
//  OBJECT'S OWN KEYS and exact-match string VALUES serialize with REAL
//  quotes: a tool input value `role: "assistant"` inside a result frame's
//  permission_denials, or a structured-output object with an `assistant`
//  key, puts the bytes `"assistant"` into a RESULT frame — and the
//  assistant arm used to RETURN before the result arm ever ran, so the
//  turn's settle never zeroed turnChars, never cleared the tail, never
//  reset the stream/settle classification. The token counter's zero-at-
//  settle law (transcript-truth commit 5) was content-dependent.
//
//    E1  a result frame whose body carries `"assistant"` still ZEROES the
//        turn count and clears the tail (the settle beat is type-keyed,
//        not substring-keyed).
//    E2  an assistant settle-class frame whose tool input carries a
//        `"stream_event"`-shaped value still counts its text (the
//        stream arm falls through on a type mismatch instead of eating
//        the frame).
//    E3  an assistant frame carrying `"init"` + `"system"` shaped values
//        still counts (the init arm falls through too).
//    E4  deltas then the SAME turn's settle-class frame: no double count
//        (the streamedThisTurn guard — pinned as a held attack).
//    E5  a torn line moves nothing and crashes nothing.
//
//  (Residue, documented not fixed: the parseless facts-poll arms —
//  task_started / task_progress / task_notification / control_response —
//  still substring-match and would eat an assistant/result frame whose
//  body carried those exact quoted tokens as nested keys or exact values.
//  They only re-ask the facts, so the cost is one missed poll beat and
//  the settle beat still lands through the typed arms; a nested key named
//  after a Mercury frame subtype is judged out of the product's shapes.)
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-seat-line-adversarial.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seatline-adv-home-'))

const { onSeatLine } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'seatline-adv-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-seatline0001'
const SHORT = 'concourse-sl1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-sl',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }

const published = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const delta = (text: string): string =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const tail = () => readSessionTail(sid, dir)
const feed = (line: string): void => onSeatLine(SHORT, line, roster as never, dir)

console.log('seat line dispatch — content-shaped frames against the substring arms')

console.log('\nE1 a result frame that MENTIONS "assistant" still settles the turn')
{
  feed(delta('The turn that must settle.'))
  await published()
  check('the deltas counted (arming the leg)', (tail()?.turnChars ?? 0) > 0, JSON.stringify(tail()))
  // The trap frame: a success result whose structured output carries an
  // `assistant` KEY — real quotes on the wire — and a permission denial
  // whose tool input VALUE is exactly "assistant".
  feed(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      structuredOutput: { assistant: 'the reply lives here' },
      permission_denials: [{ tool_name: 'X', tool_input: { role: 'assistant' } }],
    }),
  )
  await published()
  check(
    'the settle ZEROED the count (the zero-at-settle law is type-keyed, never content-dependent)',
    (tail()?.turnChars ?? 0) === 0,
    JSON.stringify(tail()),
  )
  check('the settle cleared the tail', (tail()?.text ?? null) === null, JSON.stringify(tail()?.text))
}

console.log('\nE2 an assistant frame that MENTIONS "stream_event" still counts')
{
  feed(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_x', name: 'Observe', input: { watch: 'stream_event' } },
          { type: 'text', text: 'Settled beside a tool.' },
        ],
      },
    }),
  )
  await published()
  check(
    'the settle-class text counted (the stream arm falls through on a type mismatch)',
    tail()?.turnChars === 'Settled beside a tool.'.length,
    JSON.stringify(tail()),
  )
  feed(JSON.stringify({ type: 'result', subtype: 'success' }))
  check('…and a plain result still zeroes', (tail()?.turnChars ?? 0) === 0)
}

console.log('\nE3 an assistant frame that MENTIONS "init" and "system" still counts')
{
  feed(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_y', name: 'Boot', input: { phase: 'init', kind: 'system' } },
          { type: 'text', text: 'Counted despite the mentions.' },
        ],
      },
    }),
  )
  await published()
  check(
    'the settle-class text counted (the init arm falls through)',
    tail()?.turnChars === 'Counted despite the mentions.'.length,
    JSON.stringify(tail()),
  )
  feed(JSON.stringify({ type: 'result', subtype: 'success' }))
}

console.log('\nE4 deltas then the same turn settle-class frame: never double-counted')
{
  feed(delta('Streamed once. '))
  await published()
  const afterDelta = tail()?.turnChars ?? 0
  check('the delta counted', afterDelta === 'Streamed once. '.length, String(afterDelta))
  // The same turn's frame lands as a full assistant frame (every streamed
  // reply also lands as its frame) — the guard must not re-count it.
  feed(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Streamed once. ' }] } }),
  )
  await published()
  check(
    'the frame did NOT re-count the streamed text (streamedThisTurn guards the settle arm)',
    tail()?.turnChars === 'Streamed once. '.length,
    JSON.stringify(tail()),
  )
  feed(JSON.stringify({ type: 'result', subtype: 'success' }))
}

console.log('\nE5 a torn line moves nothing and crashes nothing')
{
  const before = tail()?.turnChars ?? 0
  feed('{"type":"result","assistant" TORN MID-WRITE')
  feed('{"type":"assistant","stream_event" ALSO TORN')
  await published()
  check('torn lines moved nothing', (tail()?.turnChars ?? 0) === before, JSON.stringify(tail()))
}

console.log(
  failures === 0
    ? '\n ✅ SEAT-LINE ADVERSARIAL — the settle beat is type-keyed; mention-shaped frames fall through'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
