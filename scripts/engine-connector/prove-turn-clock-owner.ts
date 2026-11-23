#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { liveTurnStateOf } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const foldHint = ' | change liveTurnStateOf in src/sessions/resume/conversationRecovery.ts so an in-flight turn hands its open prompt clock and a settled or cut record hands none'
const startHint = ' | change LivePart.recomputeLive in src/engine/connector/daemon/live.ts so turnStartedAtMs is the facts value, else the fold value, else null, and never a fresh Date.now()'

let seq = 0
const uuid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`
const assistant = (content: unknown[], at: string): unknown => ({
  type: 'assistant',
  uuid: uuid(),
  timestamp: at,
  message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const prompt = (text: string, at: string): unknown => ({ ...(createUserMessage({ content: text }) as object), timestamp: at })

section('§1 the fold hands a start for an in-flight turn only')
{
  const daysAgo = '2026-06-20T10:00:00.000Z'
  const settled = [prompt('first', daysAgo), assistant([{ type: 'text', text: 'done' }], '2026-06-20T10:00:05.000Z')]
  const s = liveTurnStateOf(settled as never)
  check('a settled record (prompt, answer) is idle and hands NO start — never its last prompt\'s clock', s.inFlight === false && s.turnStartedAtMs === null, j(s) + foldHint)
  const open = [prompt('run it', daysAgo), assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } }], '2026-06-20T10:00:02.000Z')]
  const o = liveTurnStateOf(open as never)
  check('a record with an unresolved tool_use is in flight and hands its open prompt\'s clock', o.inFlight === true && o.turnStartedAtMs === Date.parse(daysAgo), j(o) + foldHint)
  const fresh = [prompt('the first words', '2026-09-05T09:00:00.000Z')]
  const t = liveTurnStateOf(fresh as never)
  check('a record of one unanswered prompt (a fresh session) is in flight from THAT prompt\'s clock', t.inFlight === true && t.turnStartedAtMs === Date.parse('2026-09-05T09:00:00.000Z'), j(t) + foldHint)
  const followUp = [...settled, prompt('and now this', '2026-06-20T10:01:00.000Z')]
  const f = liveTurnStateOf(followUp as never)
  check('an unanswered FOLLOW-UP prompt after an answered turn is in flight from its own clock, phase thinking (F43A-C5-20)', f.inFlight === true && f.phase === 'thinking' && f.turnStartedAtMs === Date.parse('2026-06-20T10:01:00.000Z'), j(f) + foldHint)
  const answeredAgain = [...followUp, assistant([{ type: 'text', text: 'here' }], '2026-06-20T10:01:04.000Z')]
  check('…and its text-only answer settles it idle with no start', liveTurnStateOf(answeredAgain as never).inFlight === false && liveTurnStateOf(answeredAgain as never).turnStartedAtMs === null, j(liveTurnStateOf(answeredAgain as never)) + foldHint)
  const interrupted = [...settled, prompt('go on', '2026-06-20T10:02:00.000Z'), assistant([{ type: 'text', text: 'star' }], '2026-06-20T10:02:01.000Z'), prompt('[Request interrupted by user]', '2026-06-20T10:02:02.000Z')]
  check('an interrupt marker is not an open prompt: the cut turn reads idle', liveTurnStateOf(interrupted as never).inFlight === false, j(liveTurnStateOf(interrupted as never)) + foldHint)
  const cutOff = [...settled, prompt('go on', '2026-06-20T10:03:00.000Z'), assistant([{ type: 'text', text: 'star' }], '2026-06-20T10:03:01.000Z'), prompt('[Request cut off by the no-progress timeout: 10 minutes]', '2026-06-20T10:03:02.000Z')]
  check('a typed cut line is not an open prompt either', liveTurnStateOf(cutOff as never).inFlight === false, j(liveTurnStateOf(cutOff as never)) + foldHint)
}

section("§2 the seat reads the roster's clock through the facts — never one it minted")
{
  const { LivePart } = await import('../../src/engine/connector/daemon/live.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const liveWith = (over: Record<string, unknown> = {}): InstanceType<typeof LivePart> => new LivePart({ sessionId: () => 'proof', attached: () => false, factsBusy: () => true, work: () => [], factsTurnStartedAt: () => undefined, streamIdleTimeoutMs: () => undefined, model: () => 'the-model', anySendDelivered: () => false, redressQueuedSends: () => {}, transcriptLive: () => IDLE_LIVE, toolStartedAtMs: () => null, tailHeld: () => false, clearTail: () => {}, tailInterrupted: () => {}, tailInterruptUndone: () => {}, foldStillRuns: () => true, setLiveFold: () => {}, dropRunningFoldAtIdle: () => {}, stepTurnCompletion: () => false, syncFeedCadence: () => {}, probeCarrier: () => {}, ...over } as never)
  const tailOf = (says: Record<string, unknown>): never => ({ schema: 1, sessionId: 'proof', atMs: 1, text: null, ...says }) as never
  const realNow = Date.now
  Date.now = () => 999_999
  const startOf = (facts: number | undefined, fold: number | null): number | null => {
    const seatLive = liveWith({ factsTurnStartedAt: () => facts, transcriptLive: () => ({ ...IDLE_LIVE, inFlight: true, phase: 'thinking', turnStartedAtMs: fold }) })
    seatLive.recomputeLive()
    return seatLive.live().turnStartedAtMs
  }
  const starts = { both: startOf(500, 300), foldOnly: startOf(undefined, 300), neither: startOf(undefined, null) }
  Date.now = realNow
  check("the effective facts read the daemon's turnStartedAt, else the record's fold, else nothing", starts.both === 500 && starts.foldOnly === 300 && starts.neither === null, j(starts) + startHint)
  check('no facts path mints a clock of its own (no latch, no inline Date.now())', Object.values(starts).every(start => start !== 999_999), j(starts) + startHint)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
