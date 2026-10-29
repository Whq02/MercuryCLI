#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seatline-adv-home-'))

const { onSeatRow } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')

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
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const published = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const row = (fields: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...fields })
const delta = (text: string): Record<string, unknown> => row({ type: 'text_delta', message_id: 'msg_adv', block: 0, text })
const tail = () => readSessionTail(sid, dir)
const feed = (line: Record<string, unknown>): void => onSeatRow(SHORT, line, roster as never, dir)
const outcome = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  row({ type: 'outcome', schema: 1, turn_id: 't-adv', status: 'completed', steps: 1, wall_ms: 1, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }, models: {}, denials: [], ...extra })

console.log('seat line dispatch — content-shaped rows against the typed arms')

console.log('\nE1 an outcome that MENTIONS "text" and "text_delta" still settles the turn')
{
  feed(row({ type: 'block_start', message_id: 'msg_adv', block: 0, of: 'text' }))
  feed(delta('The turn that must settle.'))
  await published()
  check('the deltas counted (arming the leg)', (tail()?.turnChars ?? 0) > 0, JSON.stringify(tail()))
  feed(outcome({ structured: { text: 'the reply lives here', type: 'text_delta' }, denials: [{ tool: 'X', call_id: 'c', input: { kind: 'text' } }] }))
  await published()
  check(
    'the settle ZEROED the count (the zero-at-settle law is type-keyed, never content-dependent)',
    (tail()?.turnChars ?? 0) === 0,
    JSON.stringify(tail()),
  )
  check('the settle cleared the tail', (tail()?.text ?? null) === null, JSON.stringify(tail()?.text))
}

console.log('\nE2 a text row that MENTIONS "block_start" still counts')
{
  feed(row({ type: 'text', message_id: 'msg_adv2', block: 0, text: 'Settled beside a "block_start" word.' }))
  await published()
  check(
    'the settle-class text counted (the type decides, not the words)',
    tail()?.turnChars === 'Settled beside a "block_start" word.'.length,
    JSON.stringify(tail()),
  )
  feed(outcome())
  check('…and a plain outcome still zeroes', (tail()?.turnChars ?? 0) === 0)
}

console.log('\nE3 a tool_call row carrying "session" and "mode" shaped values moves only liveness; the text beside it counts')
{
  feed(row({ type: 'tool_call', message_id: 'msg_adv3', block: 0, call_id: 'tu_y', tool: 'Boot', input: { phase: 'session', kind: 'mode' } }))
  feed(row({ type: 'text', message_id: 'msg_adv3', block: 1, text: 'Counted despite the mentions.' }))
  await published()
  check(
    'the settle-class text counted (the tool_call arm never ate the line)',
    tail()?.turnChars === 'Counted despite the mentions.'.length,
    JSON.stringify(tail()),
  )
  feed(outcome())
}

console.log('\nE4 deltas then the same turn settled text row: never double-counted')
{
  feed(row({ type: 'block_start', message_id: 'msg_adv4', block: 0, of: 'text' }))
  feed(delta('Streamed once. '))
  await published()
  const afterDelta = tail()?.turnChars ?? 0
  check('the delta counted', afterDelta === 'Streamed once. '.length, String(afterDelta))
  feed(row({ type: 'text', message_id: 'msg_adv4', block: 0, text: 'Streamed once. ' }))
  await published()
  check(
    'the row did NOT re-count the streamed text (streamedThisTurn guards the settle arm)',
    tail()?.turnChars === 'Streamed once. '.length,
    JSON.stringify(tail()),
  )
  feed(outcome())
}

console.log('\nE5 a torn line never reaches the seat: the door drops it and the hook sees no row')
{
  const { standInRunner } = await import('../lib/seatDoor.ts')
  const seen: unknown[] = []
  const stand = standInRunner({ hooks: { onRow: r => { seen.push(r); feed(r as Record<string, unknown>) } } })
  const before = tail()?.turnChars ?? 0
  stand.rawToHost('{"type":"outcome","text" TORN MID-WRITE\n')
  stand.rawToHost('{"type":"text","text_delta" ALSO TORN\n')
  stand.rawToHost('{"jsonrpc":"2.0","method":"row","params":{"type":"text","text" TORN INSIDE THE ENVELOPE\n')
  await new Promise(resolve => setTimeout(resolve, 30))
  await published()
  check('torn lines reached no hook and moved nothing', seen.length === 0 && (tail()?.turnChars ?? 0) === before, JSON.stringify({ seen, tail: tail() }))
  stand.close()
}

console.log(
  failures === 0
    ? '\n ✅ SEAT-LINE ADVERSARIAL — the settle beat is type-keyed; mention-shaped rows fall through'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
