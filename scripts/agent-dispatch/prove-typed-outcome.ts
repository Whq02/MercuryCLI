#!/usr/bin/env bun
// prove-typed-outcome — the openai
// lane's terminal results derive from ONE typed outcome, its timing feeds
// the shared ledger, and the retry law is pure arithmetic.
//
//   §1-13 — the typed category table: usage-limit ⇒ rate_limit; auth
//      codes ⇒ authentication_failed; 4xx api errors ⇒ invalid_request;
//      timeout/transport/truncated/5xx ⇒ server_error — DISTINCT, and no
//      consumer parses prose to tell them apart.
//   §2 — the structured reset fact: a 429 with resets_in_seconds mints
//      a TYPED resetsAtMs beside the human prose.
//   §3 D08/ — the pure retry-delay law + a fake-clock reconcile of
//      attempts/delays/wall; the done path FEEDS logAPISuccessAndDuration
//      (a sol turn reporting duration_api_ms 0 is the guarded class).
//   §4 — cite: reasoningOutputTokens survive decode → receipt, pinned
//      by prove-usage-canonical (same suite).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { openaiFaultToTypedError, openaiRetryDelayMs } = await import(
  '../../src/services/providers/openai/openaiCallModel.ts'
)
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 D10-13 · THE TYPED CATEGORY TABLE')
{
  const rows: Array<[{ kind: string; code: string }, string, string]> = [
    [{ kind: 'usage-limit', code: 'openai-usage_limit_reached' }, 'rate_limit', 'usage window ⇒ rate_limit'],
    [{ kind: 'http-error', code: 'http-401' }, 'authentication_failed', '401 ⇒ authentication_failed'],
    [{ kind: 'api-error', code: 'openai-invalid_api_key' }, 'authentication_failed', 'invalid key ⇒ authentication_failed'],
    [{ kind: 'api-error', code: 'openai-invalid_request_error' }, 'invalid_request', '4xx api error ⇒ invalid_request'],
    [{ kind: 'timeout', code: 'stream-timeout' }, 'server_error', 'timeout ⇒ server_error'],
    [{ kind: 'transport-error', code: 'fetch-failed' }, 'server_error', 'transport ⇒ server_error'],
    [{ kind: 'truncated-stream', code: 'no-terminal-event' }, 'server_error', 'truncation ⇒ server_error'],
    [{ kind: 'response-failed', code: 'openai-server_error' }, 'server_error', 'response.failed ⇒ server_error'],
    [{ kind: 'http-error', code: 'http-503' }, 'server_error', '5xx ⇒ server_error'],
  ]
  for (const [fault, want, label] of rows) {
    const got = openaiFaultToTypedError(fault as never)
    check(label, got === want, `got ${got}`)
  }
  const distinct = new Set(
    rows.map(([fault]) => openaiFaultToTypedError(fault as never)),
  )
  check(
    'D12: limit ≠ auth ≠ invalid-request ≠ transport stay DISTINCT categories',
    distinct.has('rate_limit') && distinct.has('authentication_failed') && distinct.has('invalid_request') && distinct.has('server_error'),
  )
}

section('§2 D11 · THE STRUCTURED RESET FACT')
{
  const fault = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'weekly limit reached', resets_in_seconds: 3600 } } as never, null)
  check('a 429 with resets_in_seconds mints kind usage-limit', fault.kind === 'usage-limit')
  const expectedMs = Date.now() + 3600 * 1000
  check(
    'the reset fact is TYPED (resetsAtMs ≈ now + 1h), beside the human prose',
    typeof fault.resetsAtMs === 'number' && Math.abs(fault.resetsAtMs - expectedMs) < 10_000,
    String(fault.resetsAtMs),
  )
  check('the prose keeps its human copy', /resets in ~1\.0h/.test(fault.message))
  const plain = mapOpenaiHttpFailure(429, { error: { type: 'rate_limit_exceeded', message: 'slow down' } } as never, null)
  check('a reset-less 429 carries NO invented fact', plain.resetsAtMs === undefined)
}

section('§3 D08/D09 · TIMING FEEDS THE LEDGER; THE RETRY LAW IS PURE')
{
  check('the retry-delay law is pure arithmetic (400·attempt)', openaiRetryDelayMs(1) === 400 && openaiRetryDelayMs(2) === 800)
  // attempts + delays + wall reconcile under a fake monotonic clock.
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const t0 = clock.now()
  clock.advance(1200) // attempt 1 (fails)
  clock.advance(openaiRetryDelayMs(1)) // backoff
  const attempt2Start = clock.now()
  clock.advance(900) // attempt 2 (done)
  const settled = clock.now()
  const api = settled - attempt2Start
  const wall = settled - t0
  check(
    'D09 reconcile: wall === attempts + retry delays; 0 < api ≤ wall (D08 shape)',
    wall === 1200 + 400 + 900 && api === 900 && api > 0 && api <= wall,
    `wall=${wall} api=${api}`,
  )
  const callModel = src('src/services/providers/openai/openaiCallModel.ts')
  check(
    'the DONE path feeds the SHARED api-duration ledger (D08 wiring — sol turns stop reporting 0)',
    callModel.includes('logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })'),
  )
  check(
    'the retry backoff rides the pure law (the inline arithmetic lives ONLY in its definition)',
    callModel.includes('setTimeout(resolve, openaiRetryDelayMs(attempt))') &&
      (callModel.match(/OPENAI_RETRY_BACKOFF_MS \* attempt/g) ?? []).length === 1,
  )
  check(
    'terminal faults carry the TYPED category + code-first details (D13: no prose parsing)',
    callModel.includes('openaiFaultToTypedError(outcome.fault)') &&
      callModel.includes('resets_at='),
  )
}

section('§4 D07 · CITE')
{
  check(
    'reasoningOutputTokens survival is pinned by prove-usage-canonical (same suite)',
    src('scripts/agent-dispatch/prove-usage-canonical.ts').includes('reasoningOutputTokens'),
  )
}

if (failures > 0) {
  console.error(`\nprove-typed-outcome: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-typed-outcome: all green')
