#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'turnchars-home-'))

const { onSeatRow, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')

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
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const published = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))

const row = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...o })
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const outcome = (): Record<string, unknown> => row({ type: 'outcome', schema: 1, turn_id: 't-tc', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const blockStart = (messageId: string, block: number): Record<string, unknown> => row({ type: 'block_start', message_id: messageId, block, of: 'text' })
const deltaOf = (messageId: string, block: number, text: string): Record<string, unknown> => row({ type: 'text_delta', message_id: messageId, block, text })
const settled = (messageId: string, block: number, text: string): Record<string, unknown> => row({ type: 'text', message_id: messageId, block, text })
const step = (messageId: string, outputTokens: number | undefined): Record<string, unknown> =>
  row({ type: 'step', message_id: messageId, model: 'claude-opus-5', usage: outputTokens === undefined ? {} : { ...USAGE, output_tokens: outputTokens } })
const tail = () => readSessionTail(sid, dir)

console.log('live turn chars — the counter that moves while the agent writes')

console.log('\nT1 streamed deltas accumulate')
onSeatRow(SHORT, blockStart('msg_t1', 0), roster as never, dir)
onSeatRow(SHORT, deltaOf('msg_t1', 0, 'Hello, '), roster as never, dir)
onSeatRow(SHORT, deltaOf('msg_t1', 0, 'operator.'), roster as never, dir)
await published()
check('two deltas ⇒ turnChars = their total length', tail()?.turnChars === 'Hello, operator.'.length, JSON.stringify(tail()))
check('…and the tail text still carries the block', tail()?.text === 'Hello, operator.')

console.log('\nT2 the settled row keeps the cumulative count')
onSeatRow(SHORT, settled('msg_t1', 0, 'Hello, operator.'), roster as never, dir)
check('the tail text clears at the settled row', tail()?.text === null)
check('the turn count STANDS across the boundary', tail()?.turnChars === 'Hello, operator.'.length, JSON.stringify(tail()))

console.log('\nT3 a second block keeps accumulating (per TURN, not per block)')
onSeatRow(SHORT, blockStart('msg_t1', 1), roster as never, dir)
onSeatRow(SHORT, deltaOf('msg_t1', 1, 'Second block.'), roster as never, dir)
await published()
check(
  'the second block adds to the same turn count',
  tail()?.turnChars === 'Hello, operator.'.length + 'Second block.'.length,
  JSON.stringify(tail()),
)

console.log('\nT4 the outcome row zeroes the count')
onSeatRow(SHORT, outcome(), roster as never, dir)
check('the turn settled ⇒ the count is 0 (absent or zero, never stale)', (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))

console.log('\nT5 a settle-class reply (no deltas) counts whole')
onSeatRow(SHORT, settled('msg_t5', 0, 'Settled whole.'), roster as never, dir)
check('the settle text counts at once', tail()?.turnChars === 'Settled whole.'.length, JSON.stringify(tail()))
onSeatRow(SHORT, outcome(), roster as never, dir)

console.log('\nT6 a respawn zeroes the count')
onSeatRow(SHORT, blockStart('msg_t6', 0), roster as never, dir)
onSeatRow(SHORT, deltaOf('msg_t6', 0, 'half a turn the child died inside'), roster as never, dir)
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
  const repl = read('src/screens/Chat.tsx')
  check(
    'the Chat feeds the spinner ref FROM the connector (the dead useRef(0) is gone)',
    repl.includes('getFocusedLiveResponseChars') && !repl.includes('const responseLengthRef = useRef(0)'),
  )
  check('the Chat feeds the wire figure to the verb row and the streaming hold row from the same connector', repl.includes('getFocusedLiveOutputTokens') && (repl.match(/outputTokensRef=\{outputTokensRef\}/g) ?? []).length === 2)
  check('the Chat feeds the turn facts (thinking chars, the first byte, the wait) to both rows from the same connector — the live counter never reads a dead 0 while the request is alive', repl.includes('getFocusedLiveTurnFacts') && (repl.match(/liveTurnFactsRef=\{liveTurnFactsRef\}/g) ?? []).length === 2)
  const spinner = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  const hud = read('src/components/Spinner/spinnerHud.ts')
  check(
    'the spinner still keys its display and tok/s off the ref (the fed ref revives both)',
    spinner.includes('responseLengthRef.current') && spinner.includes('smoothedOtpsRef'),
  )
  check('the spinner paints the count from the one words function (liveCounterWords: the wire figure as a fact, characters over four with the ~ mark, the thinking count apart, no count while nothing has arrived) — the old zero-persisting tokens text is gone', hud.includes('return facts.liveWords.count') && !spinner.includes('tokenDirection') && !hud.includes('tokenDirection'))
  check('the cadence beside it stays a text rate and its label says so', hud.includes('`~${facts.otps} tok/s`'))
  const hold = read('src/components/Spinner/StreamingHoldRow.tsx')
  const compact = read('src/components/Spinner.tsx')
  check('the streaming hold row and the compact line read the same figure through the one words function (liveCounterWords over the seat facts, the two refs as the fallback)', hold.includes('liveCounterWords(') && hold.includes('turnFactsOfRefs(liveChars, outputTokensRef?.current ?? null)') && compact.includes('liveCounterWords(') && compact.includes('turnFactsOfRefs(responseLengthRef.current ?? 0, outputTokensRef?.current ?? null)'))
  const { liveCounterFigure } = await import('../../src/components/Spinner/liveCounterWords.ts')
  check('the figure: no wire figure yet ⇒ characters over four, marked an estimate', JSON.stringify(liveCounterFigure({ replyChars: 1003, thinkingChars: 0, wireOutputTokens: null })) === JSON.stringify({ total: 250, thinking: 0, reply: 250, estimated: true }))
  check('the figure: a wire figure at or above the estimate ⇒ the figure itself, told as a fact', JSON.stringify(liveCounterFigure({ replyChars: 1003, thinkingChars: 0, wireOutputTokens: 777 })) === JSON.stringify({ total: 777, thinking: 0, reply: 777, estimated: false }))
  check('the figure: thinking characters count apart from the reply while the wire has not spoken', JSON.stringify(liveCounterFigure({ replyChars: 400, thinkingChars: 3000, wireOutputTokens: null })) === JSON.stringify({ total: 850, thinking: 750, reply: 100, estimated: true }))
}

console.log('\nT8 the wire figure — the turn\'s cumulative output tokens once a step has landed')
{
  onSeatRow(SHORT, outcome(), roster as never, dir)
  onSeatRow(SHORT, blockStart('msg_w1', 0), roster as never, dir)
  onSeatRow(SHORT, deltaOf('msg_w1', 0, 'Thinking it over.'), roster as never, dir)
  await published()
  check('a block start carries no usage: the figure stays absent while the characters count', tail()?.turnOutputTokens === undefined && tail()?.turnChars === 'Thinking it over.'.length, JSON.stringify(tail()))
  onSeatRow(SHORT, step('msg_w1', 777), roster as never, dir)
  check('the first step row publishes the wire figure at once', tail()?.turnOutputTokens === 777, JSON.stringify(tail()))
  check('…and the character count stands beside it', tail()?.turnChars === 'Thinking it over.'.length, JSON.stringify(tail()))
  onSeatRow(SHORT, blockStart('msg_w2', 0), roster as never, dir)
  onSeatRow(SHORT, deltaOf('msg_w2', 0, 'Second message.'), roster as never, dir)
  await published()
  check('a second message streaming adds no estimate to the figure: it stays the wire total so far', tail()?.turnOutputTokens === 777, JSON.stringify(tail()))
  onSeatRow(SHORT, step('msg_w2', 555), roster as never, dir)
  check("the second message's step adds its figure to the turn total", tail()?.turnOutputTokens === 1332, JSON.stringify(tail()))
  onSeatRow(SHORT, step('msg_w3', 0), roster as never, dir)
  onSeatRow(SHORT, step('msg_w4', undefined), roster as never, dir)
  check('a zero or absent usage states nothing: the figure stands', tail()?.turnOutputTokens === 1332, JSON.stringify(tail()))
  onSeatRow(SHORT, outcome(), roster as never, dir)
  check('the outcome row retires the figure with the count (absent, never stale)', tail()?.turnOutputTokens === undefined && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))
  onSeatRow(SHORT, blockStart('msg_w5', 0), roster as never, dir)
  onSeatRow(SHORT, deltaOf('msg_w5', 0, 'A wire that states no usage.'), roster as never, dir)
  onSeatRow(SHORT, step('msg_w5', 0), roster as never, dir)
  await published()
  check('a wire that states no usage keeps the figure absent for the whole turn (the reader keeps its ~ estimate)', tail()?.turnOutputTokens === undefined && tail()?.turnChars === 'A wire that states no usage.'.length, JSON.stringify(tail()))
  onSeatRow(SHORT, step('msg_w6', 42), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn retires the figure with the half-count', tail()?.turnOutputTokens === undefined && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))
}

console.log(
  failures === 0
    ? '\n ✅ LIVE TURN CHARS — the counter moves while the agent writes, and rests honest at zero'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
