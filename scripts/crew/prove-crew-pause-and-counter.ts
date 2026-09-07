#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-pause-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const wait = await import('../../src/tasks/LocalAgentTask/agentWait.js')
const pause = await import('../../src/tasks/LocalAgentTask/agentPause.js')
const crew = await import('../../src/services/engine-connector/crewFacts.js')
const wire = await import('../../src/services/engine-connector/seatWire.js')
const task = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const T0 = 1_700_000_000_000
const delta = (kind: 'thinking_delta' | 'text_delta' | 'input_json_delta', chars: number): unknown => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta:
      kind === 'thinking_delta'
        ? { type: kind, thinking: 'x'.repeat(chars) }
        : kind === 'text_delta'
          ? { type: kind, text: 'y'.repeat(chars) }
          : { type: kind, partial_json: 'z'.repeat(chars) },
  },
})

section('C1 — the counter moves while the model reasons')
{
  let w = wait.foldAgentWaitEvent(null, { type: 'stream_request_start' }, T0)
  w = wait.foldAgentWaitEvent(w, { type: 'stream_event', event: { type: 'message_start' } }, T0 + 1_000)
  check('the first byte in: no tokens yet', w?.phase === 'replying' && wait.agentWaitWords(w, T0 + 1_000) === 'first byte in, no tokens yet', JSON.stringify(w))
  w = wait.foldAgentWaitEvent(w, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }, T0 + 2_000)
  check('the thinking block opens: reasoning, still no tokens', w?.phase === 'reasoning' && wait.agentWaitWords(w, T0 + 5_000) === 'reasoning 3s, no tokens yet', wait.agentWaitWords(w, T0 + 5_000) ?? 'null')
  w = wait.foldAgentWaitEvent(w, delta('thinking_delta', 20), T0 + 3_000)
  check('a first small delta counts but does not yet spell (a handful is no counter)', w?.phase === 'reasoning' && w.streamedChars === 20 && wait.agentWaitWords(w, T0 + 5_000) === 'reasoning 3s, no tokens yet', JSON.stringify(w))
  for (let i = 0; i < 100; i++) w = wait.foldAgentWaitEvent(w, delta('thinking_delta', 50), T0 + 4_000 + i)
  check('the reasoning phase keeps its clock and counts every thinking delta', w?.phase === 'reasoning' && w.sinceMs === T0 + 2_000 && w.streamedChars === 5_020, JSON.stringify(w))
  const words = wait.agentWaitWords(w, T0 + 132_000)
  check('the row: reasoning with the counter and the estimate, never "no tokens yet"', words === 'reasoning 2m 10s · ~1.3k tokens so far', words ?? 'null')
  check('the words without a clock keep the estimate', wait.agentWaitWords(w, null) === 'reasoning · ~1.3k tokens so far', wait.agentWaitWords(w, null) ?? 'null')
  w = wait.foldAgentWaitEvent(w, delta('text_delta', 400), T0 + 140_000)
  check('text streams: the phase moves on and the count carries across', w?.phase === 'streaming' && w.streamedChars === 5_420 && wait.agentWaitWords(w, T0 + 141_000) === 'streaming · ~1.4k tokens so far', JSON.stringify(w))
  w = wait.foldAgentWaitEvent(w, delta('input_json_delta', 80), T0 + 142_000)
  check('tool input streams into the same count', w?.streamedChars === 5_500, JSON.stringify(w))
  const same = wait.foldAgentWaitEvent(w, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, T0 + 143_000)
  check('an event that streams nothing returns the same wait (the publisher stays quiet)', same === w)
  check('a small count spells whole tokens', wait.streamedTokensWords(200) === '~50 tokens so far' && wait.streamedTokensWords(36) === null && wait.streamedTokensWords(undefined) === null, String(wait.streamedTokensWords(200)))
}

section('C2 — the wire: the counter and a pause cross the feed and read back')
{
  const answer = {
    model: { effective: 'claude-opus-5' },
    usage: { totalCostUSD: 0 },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { originalCwd: '/w', projectRoot: '/w' },
    queue: [],
    work: [
      {
        id: 'agent-1',
        kind: 'agent',
        name: 'reader',
        status: 'running',
        startTime: T0,
        phase: { phase: 'reasoning', sinceMs: T0, streamedChars: 4_000 },
      },
      {
        id: 'agent-2',
        kind: 'agent',
        name: 'writer',
        status: 'failed',
        startTime: T0,
        endTime: T0 + 60_000,
        error: 'the usage window is spent',
        paused: { why: 'usage limit', words: "Opus 5's 5-hour limit is spent until 15:00", resumesAtMs: T0 + 3_600_000 },
      },
    ],
  }
  const onWire = wire.sessionFactsToWire(answer as never) as { work?: Array<Record<string, unknown>> }
  const first = onWire.work?.[0] as { phase?: Record<string, unknown> }
  const second = onWire.work?.[1] as { paused?: Record<string, unknown> }
  check('the counter rides snake_case on the wire', first?.phase?.streamed_chars === 4_000 && first.phase.since_ms === T0 && !('streamedChars' in (first.phase ?? {})), JSON.stringify(first?.phase))
  check('the pause rides snake_case on the wire', second?.paused?.resumes_at_ms === T0 + 3_600_000 && second.paused.why === 'usage limit' && !('resumesAtMs' in (second.paused ?? {})), JSON.stringify(second?.paused))
  const back = wire.sessionFactsFromWire(JSON.parse(JSON.stringify(onWire)))
  const rows = (back as { work?: Array<Record<string, unknown>> } | null)?.work ?? []
  check('…and read back in the record\'s spelling', (rows[0]?.phase as { streamedChars?: number } | undefined)?.streamedChars === 4_000 && (rows[1]?.paused as { resumesAtMs?: number } | undefined)?.resumesAtMs === T0 + 3_600_000, JSON.stringify(rows.map(r => [r.phase, r.paused])))
}

section('C3 — the paused row says PAUSED with why and the countdown')
{
  const now = T0 + 120_000
  const paused = crew.crewAgentFactsOf(
    {
      id: 'agent-2',
      kind: 'agent',
      name: 'writer',
      status: 'failed',
      startTime: T0,
      endTime: T0 + 60_000,
      error: 'the usage window is spent',
      paused: { why: 'usage limit', words: "Opus 5's 5-hour limit is spent until 15:00", resumesAtMs: now + 42 * 60_000 },
    } as never,
    null,
  )
  const busy = crew.crewAgentFactsOf(
    { id: 'agent-3', kind: 'agent', name: 'fixer', status: 'failed', startTime: T0, endTime: T0 + 30_000, paused: { why: 'provider busy', words: 'the provider refused 3 times in a row (HTTP 429, busy) — the 20m retry budget is spent' } } as never,
    null,
  )
  const running = crew.crewAgentFactsOf({ id: 'agent-1', kind: 'agent', name: 'reader', status: 'running', startTime: T0, paused: { why: 'usage limit', words: 'stale' } } as never, null)
  const failed = crew.crewAgentFactsOf({ id: 'agent-4', kind: 'agent', name: 'lost', status: 'failed', startTime: T0, endTime: T0 + 10, error: 'crashed' } as never, null)
  check('a settled row carrying a pause is paused, not failed', paused !== null && paused.state === 'paused' && paused.paused !== null && crew.crewStateLabel(paused) === 'paused', JSON.stringify(paused?.state))
  check('the status cell: paused, why, and the countdown', paused !== null && crew.crewStatusWords(paused, now) === `paused — usage limit · resumes by itself at ${pause.pauseClockWords(now + 42 * 60_000)} (in 42m)`, paused === null ? 'null' : crew.crewStatusWords(paused, now))
  check('a pause with no stated reset says so', busy !== null && crew.crewStatusWords(busy, now) === 'paused — provider busy · no reset stated — a message resumes it', busy === null ? 'null' : crew.crewStatusWords(busy, now))
  check('a countdown that has run out reads "resuming now"', paused !== null && crew.crewStatusWords(paused, now + 43 * 60_000) === 'paused — usage limit · resuming now')
  check("the row's line carries the pause's own words and the doors", paused !== null && crew.crewPauseLine(paused, now) === `paused — usage limit · resumes by itself at ${pause.pauseClockWords(now + 42 * 60_000)} (in 42m); Opus 5's 5-hour limit is spent until 15:00; ${pause.AGENT_PAUSE_DOORS}`, paused === null ? 'null' : String(crew.crewPauseLine(paused, now)))
  check('a running row is never paused, whatever it carries', running !== null && running.state === 'running' && crew.crewPauseLine(running, now) === null)
  check('a failed row without a pause keeps its word', failed !== null && failed.state === 'failed' && failed.paused === null && crew.crewStatusWords(failed, now) === 'failed')
  const all = [running!, paused!, busy!, failed!]
  check('the count line counts the paused rows', crew.crewCountLabel(all) === '1 running · 2 paused · 4 sub-agents' && crew.crewPaused(all).length === 2, crew.crewCountLabel(all))
  check('a crew with no pause keeps the old count line', crew.crewCountLabel([running!, failed!]) === '1 running · 2 sub-agents')
  check('a malformed pause on the wire is no pause', crew.crewStateOf({ status: 'failed', paused: { why: 'tired' } } as never) === 'failed' && pause.decodeAgentPause({ why: 'usage limit' }) === null)
}

section("C4 — the pause's owner: the provider's typed refusal pauses; anything else does not")
{
  const refusal = {
    type: 'assistant',
    uuid: 'a1',
    timestamp: new Date(T0).toISOString(),
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { id: 'm1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "Anthropic says this account's 5-hour limit is reached" }], usage: { input_tokens: 0, output_tokens: 0 } },
  }
  const plain = { ...refusal, uuid: 'a2', isApiErrorMessage: false, error: undefined, message: { ...refusal.message, model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] } }
  const fault = { ...refusal, uuid: 'a3', error: 'server_error' }
  const windowPause = task.usageWindowPauseOf([plain, refusal] as never, 'claude-opus-5')
  check('the refusal row pauses: why is the usage limit, the model named, no reset without an observed window', windowPause !== null && windowPause.why === 'usage limit' && /usage window is spent$/.test(windowPause.words) && windowPause.resumesAtMs === undefined, JSON.stringify(windowPause))
  check('a plain reply pauses nothing', task.usageWindowPauseOf([refusal, plain] as never, 'claude-opus-5') === null)
  check('a fault row (not a refusal) pauses nothing', task.usageWindowPauseOf([fault] as never, 'claude-opus-5') === null)
  check('an empty run pauses nothing', task.usageWindowPauseOf([] as never, 'claude-opus-5') === null)
  check('the countdown spelling', pause.pauseCountdownWords(8_000) === '8s' && pause.pauseCountdownWords(4 * 60_000) === '4m' && pause.pauseCountdownWords(72 * 60_000) === '1h12m' && pause.pauseCountdownWords(2 * 3_600_000) === '2h')
  check('the resume words', pause.pauseResumeWords({}, T0) === 'no reset stated — a message resumes it' && pause.pauseResumeWords({ resumesAtMs: T0 - 1 }, T0) === 'resuming now' && pause.pauseResumeWords({ resumesAtMs: T0 + 90_000 }, T0).startsWith('resumes by itself at '))
}

console.log(failures === 0 ? '\nprove-crew-pause-and-counter: all green' : `\nprove-crew-pause-and-counter: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
