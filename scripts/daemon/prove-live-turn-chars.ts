#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'turnchars-home-'))

const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'turnchars-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-turnchars001'
const SHORT = 'concourse-tc1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-tc',
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
const blockStop = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } })
const tail = () => readSessionTail(sid, dir)

console.log('live turn chars — the counter that moves while the agent writes')

console.log('\nT1 streamed deltas accumulate')
onSeatLine(SHORT, delta('Hello, '), roster as never, dir)
onSeatLine(SHORT, delta('operator.'), roster as never, dir)
await published()
check('two deltas ⇒ turnChars = their total length', tail()?.turnChars === 'Hello, operator.'.length, JSON.stringify(tail()))
check('…and the tail text still carries the block', tail()?.text === 'Hello, operator.')

console.log('\nT2 a block boundary keeps the cumulative count')
onSeatLine(SHORT, blockStop, roster as never, dir)
check('the tail text clears at the block stop', tail()?.text === null)
check('the turn count STANDS across the boundary', tail()?.turnChars === 'Hello, operator.'.length, JSON.stringify(tail()))

console.log('\nT3 a second block keeps accumulating (per TURN, not per block)')
onSeatLine(SHORT, delta('Second block.'), roster as never, dir)
await published()
check(
  'the second block adds to the same turn count',
  tail()?.turnChars === 'Hello, operator.'.length + 'Second block.'.length,
  JSON.stringify(tail()),
)

console.log('\nT4 the result frame zeroes the count')
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
check('the turn settled ⇒ the count is 0 (absent or zero, never stale)', (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))

console.log('\nT5 a settle-class reply (no deltas) counts whole')
onSeatLine(
  SHORT,
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Settled whole.' }] } }),
  roster as never,
  dir,
)
check('the settle text counts at once', tail()?.turnChars === 'Settled whole.'.length, JSON.stringify(tail()))
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)

console.log('\nT6 a respawn zeroes the count')
onSeatLine(SHORT, delta('half a turn the child died inside'), roster as never, dir)
onSeatSpawned(SHORT, roster as never, dir)
check('the respawn clears the half-count', (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))

console.log('\nT7 the wiring — connector to ref to spinner (structural)')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the connector relays the live count (turnChars)', connector.includes('turnChars'))
  const seatLive = read('src/services/engine-connector/seatLive.ts')
  check('the seat-live extension declares the accessor', seatLive.includes('turnChars'))
  const repl = read('src/screens/REPL.tsx')
  check(
    'the REPL feeds the spinner ref FROM the connector (the dead useRef(0) is gone)',
    repl.includes('getFocusedLiveResponseChars') && !repl.includes('const responseLengthRef = useRef(0)'),
  )
  const spinner = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  check(
    'the spinner still keys its display and tok/s off the ref (the fed ref revives both)',
    spinner.includes('responseLengthRef.current') && spinner.includes('smoothedOtpsRef'),
  )
}

console.log(
  failures === 0
    ? '\n ✅ LIVE TURN CHARS — the counter moves while the agent writes, and rests honest at zero'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
