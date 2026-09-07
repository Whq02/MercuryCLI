#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'window-retry-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.NODE_ENV

const budget = await import('../../src/services/api/recoveryBudget.js')
const retry = await import('../../src/services/api/withRetry.js')
const errors = await import('../../src/services/api/errors.js')
const { APIError } = await import('../../src/services/api/sdkErrors.js')
const auth = await import('../../src/utils/auth.js')
const { CLAUDE_AI_OAUTH_SCOPES } = await import('../../src/constants/oauth.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const answer = (status: number, headers: Record<string, string> = {}, message = `${status} refused`): Error =>
  Object.assign(new Error(message), { status, headers })

const CAP_MS = budget.recoveryBudgetMs()
const HOURS_3 = String(3 * 3600)

section('W1 — the window rule')
{
  check('the budget is 20 minutes by default (the patience setting)', CAP_MS === 20 * 60_000, String(CAP_MS))
  check('a wait inside the budget is a burst', !budget.providerWaitIsWindow(30_000) && !budget.providerWaitIsWindow(CAP_MS))
  check('a wait past the budget is the window', budget.providerWaitIsWindow(CAP_MS + 1) && budget.providerWaitIsWindow(3 * 3_600_000))
  check('no wait named is no window', !budget.providerWaitIsWindow(undefined) && !budget.providerWaitIsWindow(Number.NaN))
  check('the budget off makes every wait a burst', !budget.providerWaitIsWindow(3 * 3_600_000, Infinity))
  check('a custom cap', budget.providerWaitIsWindow(7_000, 6_000) && !budget.providerWaitIsWindow(6_000, 6_000))
}

section('W2 — the reader: the wait off the headers')
{
  const now = Math.floor(Date.now() / 1000) * 1000
  check('Retry-After in seconds', budget.providerAskedWaitMs(answer(429, { 'retry-after': '30' }), now) === 30_000)
  check('Retry-After as an HTTP date', budget.providerAskedWaitMs(answer(429, { 'retry-after': new Date(now + 120_000).toUTCString() }), now) === 120_000)
  check("the usage window's stated reset (an epoch in seconds)", budget.providerAskedWaitMs(answer(429, { 'anthropic-ratelimit-unified-reset': String(Math.floor(now / 1000) + 5400) }), now) === 5_400_000)
  check('Retry-After outranks the reset', budget.providerAskedWaitMs(answer(429, { 'retry-after': '5', 'anthropic-ratelimit-unified-reset': String(Math.floor(now / 1000) + 5400) }), now) === 5_000)
  check('a reset already passed names no wait', budget.providerAskedWaitMs(answer(429, { 'anthropic-ratelimit-unified-reset': String(Math.floor(now / 1000) - 60) }), now) === undefined)
  check('no header, no wait', budget.providerAskedWaitMs(answer(429), now) === undefined && budget.providerAskedWaitMs(new Error('x'), now) === undefined && budget.providerAskedWaitMs(null, now) === undefined)
  check('the spent-window mark: the unified status rejected', budget.isSpentUsageWindowAnswer(answer(429, { 'anthropic-ratelimit-unified-status': 'rejected' })) && !budget.isSpentUsageWindowAnswer(answer(429, { 'anthropic-ratelimit-unified-status': 'allowed' })) && !budget.isSpentUsageWindowAnswer(answer(429)))
}

section('W3 — the retry decision on the API-key road')
{
  check('the road is the API key (no sign-in stored)', !auth.isClaudeAISubscriber())
  check('a 429 with a short Retry-After is retried', retry.isRetryableError(answer(429, { 'retry-after': '30' })))
  check('a bare 429 is retried (the ladder)', retry.isRetryableError(answer(429)))
  check('a 429 asking for three hours is not: the window', !retry.isRetryableError(answer(429, { 'retry-after': HOURS_3 })))
  check('a 503 asking for three hours is not either', !retry.isRetryableError(answer(503, { 'retry-after': HOURS_3 })))
  check('a 503 asking for a minute is', retry.isRetryableError(answer(503, { 'retry-after': '60' })))
  check('a 429 asking for exactly the budget is a burst', retry.isRetryableError(answer(429, { 'retry-after': String(CAP_MS / 1000) })))
  check('the hint cannot make a window retryable', !retry.isRetryableError(answer(429, { 'retry-after': HOURS_3, 'x-should-retry': 'true' })))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0'
  check('the budget off: every wait is a burst, three hours included', retry.isRetryableError(answer(429, { 'retry-after': HOURS_3 })))
  delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
}

section('W4 — the retry decision on the subscription road')
{
  auth.saveOAuthTokensIfNeeded({
    accessToken: 'at-fixture',
    refreshToken: 'rt-fixture',
    expiresAt: Date.now() + 3_600_000,
    scopes: [...CLAUDE_AI_OAUTH_SCOPES],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
  } as never)
  auth.clearOAuthTokenCache()
  check('the road is the first-party subscription (a stored sign-in)', auth.isClaudeAISubscriber() && !auth.isEnterpriseSubscriber())
  check('a burst 429 with a short Retry-After is retried — the seat waits it out inside its budget', retry.isRetryableError(answer(429, { 'retry-after': '5' })))
  check('a bare 429 is retried (the ladder)', retry.isRetryableError(answer(429)))
  check('a spent usage window (the unified status rejected) is not: the turn ends on the typed row', !retry.isRetryableError(answer(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 5400) })))
  check('a 429 asking for three hours is not: the window', !retry.isRetryableError(answer(429, { 'retry-after': HOURS_3 })))
  check('a 429 with an allowed status and a short reset is a burst', retry.isRetryableError(answer(429, { 'anthropic-ratelimit-unified-status': 'allowed', 'retry-after': '20' })))
  check('the hint is still honoured only off the subscription road', !retry.isRetryableError(answer(418, { 'x-should-retry': 'true' })))
}

section('W5 — the row carries the asked wait as a fact')
{
  const before = Date.now()
  const wireAnswer = (status: number, headers: Record<string, string>): Error =>
    new APIError(status, { type: 'error', error: { type: 'rate_limit_error', message: 'refused' } }, `${status} refused`, new Headers(headers))
  const window = errors.getAssistantMessageFromError(wireAnswer(429, { 'retry-after': HOURS_3, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(Math.floor(before / 1000) + 3 * 3600) }), 'claude-opus-5')
  check('the subscription window row is typed rate_limit and stamps the moment the wait ends', window.isApiErrorMessage === true && window.error === 'rate_limit' && typeof window.providerWaitEndsAtMs === 'number' && window.providerWaitEndsAtMs >= before + 3 * 3_600_000 - 5_000 && window.providerWaitEndsAtMs <= Date.now() + 3 * 3_600_000 + 5_000, JSON.stringify({ error: window.error, ends: window.providerWaitEndsAtMs }))
  auth.clearOAuthTokenCache()
  const keyRow = errors.getAssistantMessageFromError(answer(429, { 'retry-after': '90' }), 'claude-opus-5')
  check('a refusal row that names a wait carries it; one that names none carries none', typeof keyRow.providerWaitEndsAtMs === 'number' && keyRow.providerWaitEndsAtMs >= before + 90_000 - 5_000 && errors.getAssistantMessageFromError(answer(429), 'claude-opus-5').providerWaitEndsAtMs === undefined, JSON.stringify(keyRow.providerWaitEndsAtMs))
  const fault = errors.getAssistantMessageFromError(answer(503, { 'retry-after': HOURS_3 }), 'claude-opus-5')
  check('a fault asking for hours carries the moment too', typeof fault.providerWaitEndsAtMs === 'number' && fault.providerWaitEndsAtMs >= before + 3 * 3_600_000 - 5_000, JSON.stringify(fault.providerWaitEndsAtMs))
}

console.log(failures === 0 ? '\nprove-window-retry: all green' : `\nprove-window-retry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
