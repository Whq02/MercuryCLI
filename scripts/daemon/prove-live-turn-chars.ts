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
  check('the connector relays the wire figure beside it (turnOutputTokens), absent as null', connector.includes('turnOutputTokens(): number | null') && connector.includes("typeof tail.turnOutputTokens === 'number' ? tail.turnOutputTokens : null"))
  const seatLive = read('src/services/engine-connector/seatLive.ts')
  check('the seat-live extension declares the accessor', seatLive.includes('turnChars'))
  check('the seat-live extension declares the wire figure accessor', seatLive.includes('turnOutputTokens?(): number | null'))
  const repl = read('src/screens/REPL.tsx')
  check(
    'the REPL feeds the spinner ref FROM the connector (the dead useRef(0) is gone)',
    repl.includes('getFocusedLiveResponseChars') && !repl.includes('const responseLengthRef = useRef(0)'),
  )
  check('the REPL feeds the wire figure to the verb row and the streaming hold row from the same connector', repl.includes('getFocusedLiveOutputTokens') && (repl.match(/outputTokensRef=\{outputTokensRef\}/g) ?? []).length === 2)
  const spinner = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  check(
    'the spinner still keys its display and tok/s off the ref (the fed ref revives both)',
    spinner.includes('responseLengthRef.current') && spinner.includes('smoothedOtpsRef'),
  )
  check('the spinner paints the wire figure as a fact and the characters-over-four figure with its ~ mark', spinner.includes("${tokensEstimated ? '~' : ''}${formatNumber(displayedTokens)} tokens"))
  check('the cadence beside it stays a text rate and its label says so', spinner.includes('`~${otps} tok/s`'))
  const hold = read('src/components/Spinner/StreamingHoldRow.tsx')
  const compact = read('src/components/Spinner.tsx')
  check('the streaming hold row and the compact line read the same figure through the one helper', hold.includes('liveTokenFigure(liveChars, outputTokensRef?.current ?? null)') && compact.includes('liveTokenFigure(responseLengthRef.current ?? 0, outputTokensRef?.current ?? null)'))
  const { liveTokenFigure } = await import('../../src/components/Spinner/SpinnerAnimationRow.tsx')
  check('the helper: no wire figure yet ⇒ characters over four, marked an estimate', JSON.stringify(liveTokenFigure(1003, null)) === JSON.stringify({ count: 250, estimated: true }))
  check('the helper: a wire figure ⇒ the figure itself, told as a fact', JSON.stringify(liveTokenFigure(1003, 777)) === JSON.stringify({ count: 777, estimated: false }))
}

console.log('\nT8 the wire figure — the turn\'s cumulative output tokens once usage has arrived')
{
  const ev = (event: Record<string, unknown>): string => JSON.stringify({ type: 'stream_event', event })
  onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_w1', usage: { input_tokens: 20, output_tokens: 1 } } }), roster as never, dir)
  onSeatLine(SHORT, delta('Thinking it over.'), roster as never, dir)
  await published()
  check('message_start usage is not a usage frame: the figure stays absent while the characters count', tail()?.turnOutputTokens === undefined && tail()?.turnChars === 'Thinking it over.'.length, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 777 } }), roster as never, dir)
  check('the first message_delta usage publishes the wire figure at once', tail()?.turnOutputTokens === 777, JSON.stringify(tail()))
  check('…and the character count stands beside it', tail()?.turnChars === 'Thinking it over.'.length, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_stop' }), roster as never, dir)
  check('the message boundary keeps the figure', tail()?.turnOutputTokens === 777, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_w2', usage: { input_tokens: 30, output_tokens: 1 } } }), roster as never, dir)
  onSeatLine(SHORT, delta('Second message.'), roster as never, dir)
  await published()
  check('a second message streaming adds no estimate to the figure: it stays the wire total so far', tail()?.turnOutputTokens === 777, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 200 } }), roster as never, dir)
  check('a cumulative usage frame mid-message adds the message so far', tail()?.turnOutputTokens === 977, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 555 } }), roster as never, dir)
  check('a later cumulative frame REPLACES the message figure, never adds twice', tail()?.turnOutputTokens === 1332, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_stop' }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: {} }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }), roster as never, dir)
  check('a zero, absent or missing usage states nothing: the figure stands', tail()?.turnOutputTokens === 1332, JSON.stringify(tail()))
  onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
  check('the result frame retires the figure with the count (absent, never stale)', tail()?.turnOutputTokens === undefined && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_w3', usage: {} } }), roster as never, dir)
  onSeatLine(SHORT, delta('A wire that states no usage.'), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'message_stop' }), roster as never, dir)
  await published()
  check('a wire that states no usage keeps the figure absent for the whole turn (the reader keeps its ~ estimate)', tail()?.turnOutputTokens === undefined && tail()?.turnChars === 'A wire that states no usage.'.length, JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn retires the figure with the half-count', tail()?.turnOutputTokens === undefined && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))
}

console.log(
  failures === 0
    ? '\n ✅ LIVE TURN CHARS — the counter moves while the agent writes, and rests honest at zero'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
