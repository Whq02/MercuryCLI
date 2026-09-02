#!/usr/bin/env bun
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
