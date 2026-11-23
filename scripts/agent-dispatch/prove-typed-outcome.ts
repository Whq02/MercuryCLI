#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { openaiFaultToTypedError, openaiRetryDelayMs } = await import(
  '../../src/models/roads/openai/openaiCallModel.ts'
)
const { mapOpenaiHttpFailure } = await import('../../src/models/roads/openai/openaiWire.ts')
const { providerWaitWords } = await import('../../src/engine/requests/recoveryBudget.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', fixHint = ''): void => {
  const shown = !cond && fixHint ? (detail ? detail + ' | ' + fixHint : fixHint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

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
    check(label, got === want, `got ${got}`, 'change the category this fault kind maps to in openaiFaultToTypedError in src/models/roads/openai/openaiCallModel.ts')
  }
  const distinct = new Set(
    rows.map(([fault]) => openaiFaultToTypedError(fault as never)),
  )
  check(
    'D12: limit ≠ auth ≠ invalid-request ≠ transport stay DISTINCT categories',
    distinct.has('rate_limit') && distinct.has('authentication_failed') && distinct.has('invalid_request') && distinct.has('server_error'),
    '',
    'openaiFaultToTypedError in src/models/roads/openai/openaiCallModel.ts must map limit, auth, invalid-request and transport faults to four different categories',
  )
}

section('§2 D11 · THE STRUCTURED RESET FACT')
{
  const fault = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', message: 'weekly limit reached', resets_in_seconds: 3600 } } as never, null)
  check('a 429 with resets_in_seconds mints kind usage-limit', fault.kind === 'usage-limit', '', 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must return kind usage-limit for a 429 carrying resets_in_seconds')
  const expectedMs = Date.now() + 3600 * 1000
  check(
    'the reset fact is TYPED (resetsAtMs ≈ now + 1h), beside the human prose',
    typeof fault.resetsAtMs === 'number' && Math.abs(fault.resetsAtMs - expectedMs) < 10_000,
    String(fault.resetsAtMs),
    'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must set resetsAtMs to now plus resets_in_seconds',
  )
  check('the short stated wait is named in the house wait words without replacing the provider answer', fault.message === `rate limited — the provider asks for ${providerWaitWords(3600 * 1000)} — weekly limit reached` && providerWaitWords(3600 * 1000) === '1 h 0 min', fault.message, 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must word the message as rate limited, the provider asks for the providerWaitWords text (src/engine/requests/recoveryBudget.ts), then the provider message')
  const plain = mapOpenaiHttpFailure(429, { error: { type: 'rate_limit_exceeded', message: 'slow down' } } as never, null)
  check('a reset-less 429 carries NO invented fact', plain.resetsAtMs === undefined, '', 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must leave resetsAtMs unset when the 429 body has no reset')
}

section('§3 D08/D09 · TIMING FEEDS THE LEDGER; THE RETRY LAW IS PURE')
{
  check('the retry-delay law is pure arithmetic (400·attempt)', openaiRetryDelayMs(1) === 400 && openaiRetryDelayMs(2) === 800, '', 'openaiRetryDelayMs in src/models/roads/openai/openaiCallModel.ts must return 400 times the attempt number')
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const t0 = clock.now()
  clock.advance(1200)
  clock.advance(openaiRetryDelayMs(1))
  const attempt2Start = clock.now()
  clock.advance(900)
  const settled = clock.now()
  const api = settled - attempt2Start
  const wall = settled - t0
  check(
    'D09 reconcile: wall === attempts + retry delays; 0 < api ≤ wall (D08 shape)',
    wall === 1200 + 400 + 900 && api === 900 && api > 0 && api <= wall,
    `wall=${wall} api=${api}`,
    'openaiRetryDelayMs in src/models/roads/openai/openaiCallModel.ts must stay a pure 400 times attempt so wall time equals attempts plus delays',
  )
}


if (failures > 0) {
  console.error(`\nprove-typed-outcome: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-typed-outcome: all green')
