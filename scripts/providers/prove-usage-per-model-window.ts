#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'usage-window-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '30'
delete process.env.MERCURY_HOME
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + t)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
auth.clearOAuthTokenCache()
writeFileSync(join(HOME, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: Date.now() + 7 * 24 * 3600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: null } }))
auth.clearOAuthTokenCache()
const { APIError } = await import('../../src/services/api/sdkErrors.js')
const limits = await import('../../src/services/anthropicLimits.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const { fullWindowLine } = await import('../../src/components/Settings/Usage.tsx')
const { usagePopupLine } = await import('../../src/components/Settings/usageLine.ts')
const { composeUsageReading } = await import('../../src/cli/handlers/usage.ts')
const { failoverCauseOf, withBackupVote } = await import('../../src/services/api/backupEngines.ts')

const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => 'ana@example.com')
const FABLE = 'claude-fable-5-1'
const SONNET = 'claude-sonnet-4-6'
const WAIT_S = 445_400
const now = Date.now()

const rejected = (headers: Record<string, string>): InstanceType<typeof APIError> =>
  new APIError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }, undefined, new Headers(headers) as never)
const limitedOf = () => usage.anthropicLimitedWindow(undefined, Date.now())
const screenLine = (model: string): string | undefined => fullWindowLine(usage.usageForProvider('anthropic'), model)
const fresh = (): void => {
  limits.resetLimitsForCredentialSwitch()
  limits.__setRawUtilizationForTest({
    five_hour: { utilization: 0.31, resets_at: Math.floor(now / 1000) + 3_600, source: 'headers', observedAtMs: now },
    seven_day: { utilization: 0.56, resets_at: Math.floor(now / 1000) + 86_400, source: 'headers', observedAtMs: now },
  })
}

section('§1 a 429 naming the Fable week beside shared figures of 31% and 56%: the window is shown with its reset and the model it binds')
{
  fresh()
  const resetAt = Math.floor(now / 1000) + WAIT_S
  limits.extractQuotaStatusFromError(rejected({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable', 'anthropic-ratelimit-unified-reset': String(resetAt), 'anthropic-ratelimit-unified-5h-utilization': '0.31', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3_600), 'anthropic-ratelimit-unified-7d-utilization': '0.56', 'anthropic-ratelimit-unified-7d-reset': String(Math.floor(now / 1000) + 86_400), 'retry-after': String(WAIT_S) }))
  const limited = limitedOf()
  check('the owner view carries the closed window', limited !== undefined && limited.claim === 'seven_day_fable' && limited.windowName === 'Fable limit' && limited.resetsAtMs === resetAt * 1000, JSON.stringify(limited))
  const view = usage.usageForProvider('anthropic')
  check('the shared figures still read 31% and 56% beside it', view.windows.map(w => `${w.key} ${Math.floor(w.usedPct ?? -1)}`).join(' · ') === '5h 31 · 7d 56' && view.limited?.windowName === 'Fable limit', JSON.stringify(view.windows))
  const line = screenLine(FABLE)
  check('the usage screen names the window, its reset and the model it binds', line !== undefined && line.startsWith('The Fable limit is reached — resets ') && line.includes(` · binds ${FABLE}`), line)
  const other = screenLine(SONNET)
  check('…and says when the session model is outside the window', other !== undefined && other.includes(`binds the Fable models, not ${SONNET}`), other)
  const popup = usagePopupLine()
  check('the figures line (/usage header and mercury usage) carries it after the account figures', /session 31% · week 56% · Fable limit reached · resets 5d \d+h · binds /.test(popup), popup)
  const reading = await composeUsageReading(now) as { active?: { limited?: Record<string, unknown> } }
  check('mercury usage --json carries the closed window typed (resetsAt, claim, windowName, binds)', reading.active?.limited?.claim === 'seven_day_fable' && reading.active?.limited?.windowName === 'Fable limit' && reading.active?.limited?.resetsAt === new Date(resetAt * 1000).toISOString() && typeof reading.active?.limited?.binds === 'string' && String(reading.active?.limited?.binds).includes('binds '), JSON.stringify(reading.active?.limited))
}

section('§2 a 429 with only a Retry-After past the retry budget closes the window until then')
{
  fresh()
  limits.extractQuotaStatusFromError(rejected({ 'retry-after': String(WAIT_S) }))
  const limited = limitedOf()
  const expectedMs = (Math.floor(now / 1000) + WAIT_S) * 1000
  check('the window closes until the asked wait, no claim named', limited !== undefined && limited.claim === undefined && Math.abs(limited.resetsAtMs - expectedMs) <= 2_000, JSON.stringify(limited))
  const line = screenLine(FABLE)
  check('the screen says a usage window is reached, binding every model', line !== undefined && line.startsWith('A usage window is reached — resets ') && line.includes(`binds every model, ${FABLE} among them`), line)
  check('the account figures still paint beside a Retry-After closed window', /session 31% · week 56% · limit reached · resets 5d \d+h · binds /.test(usagePopupLine()), usagePopupLine())
  check('the words name the model the session runs', usage.limitBindsWords(undefined, FABLE) === `binds every model, ${FABLE} among them`)
  const reading = await composeUsageReading(now) as { active?: { limited?: Record<string, unknown> } }
  check('mercury usage --json carries binds on a Retry-After closed window too', typeof reading.active?.limited?.resetsAt === 'string' && typeof reading.active?.limited?.binds === 'string' && String(reading.active?.limited?.binds).startsWith('binds every model, '), JSON.stringify(reading.active?.limited))
}

section('§3 the window clears when the reset passes, and the seat never hops models on it')
{
  fresh()
  const resetAt = Math.floor(now / 1000) + 10
  limits.extractQuotaStatusFromError(rejected({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable', 'anthropic-ratelimit-unified-reset': String(resetAt) }))
  const viewAtWall = usage.usageForProvider('anthropic')
  const cachedBefore = usagePopupLine()
  check('before the reset passes: the popup line carries the closed window', cachedBefore.includes('Fable limit reached'), cachedBefore)
  const afterMs = (resetAt + 5) * 1000
  check('usageWindowReached clears once the clock passes the reset', usage.usageWindowReached(viewAtWall, afterMs) === null, String(usage.usageWindowReached(viewAtWall, afterMs)))
  check('anthropicWindowClosed clears once the clock passes the reset', limits.anthropicWindowClosed(limits.currentLimits, afterMs) === false, String(limits.anthropicWindowClosed(limits.currentLimits, afterMs)))
  const realDateNow = Date.now
  try {
    Date.now = () => afterMs
    check('after the reset passes: the screen paints no stale reached line, even inside the cache window', screenLine(FABLE) === undefined && !usagePopupLine().includes('limit reached') && usagePopupLine().endsWith('session 31% · week 56%'), `${screenLine(FABLE)} | ${usagePopupLine()}`)
    const readingAfter = await composeUsageReading(afterMs) as { active?: { limited?: unknown } }
    check('mercury usage --json clears limited after the reset passes', readingAfter.active?.limited === undefined, JSON.stringify(readingAfter.active?.limited))
  } finally {
    Date.now = realDateNow
  }
  check('a usage window / rate limit is not a backup-engine failover cause', failoverCauseOf('rate_limit', undefined, false) === undefined)
  let hopped = false
  try {
    const stream = withBackupVote((async function* () {
      yield { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'The Fable limit is reached' }] } } as never
    })(), { model: FABLE, fallbackModel: SONNET })
    for await (const _ of stream) { void _ }
  } catch {
    hopped = true
  }
  check('the seat never hops models on a usage window refusal', !hopped)
}

section('§4 refusals: a burst, a passed reset, a headroom answer and the control')
{
  fresh()
  limits.extractQuotaStatusFromError(rejected({ 'retry-after': '20' }))
  check('a 429 with a 20 s Retry-After is a burst: no window closes', limitedOf() === undefined && limits.currentLimits.status === 'allowed', JSON.stringify(limits.currentLimits))
  check('…and the screen paints no reached line', screenLine(FABLE) === undefined)
  fresh()
  limits.extractQuotaStatusFromError(rejected({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable', 'anthropic-ratelimit-unified-reset': String(Math.floor(now / 1000) - 60) }))
  check('a stated reset already past closes nothing', limitedOf() === undefined, JSON.stringify(limitedOf()))
  fresh()
  limits.extractQuotaStatusFromError(rejected({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable', 'anthropic-ratelimit-unified-reset': String(Math.floor(now / 1000) + WAIT_S) }))
  limits.extractQuotaStatusFromHeaders(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }), Date.now() + 1)
  check('a later reply with headroom reopens it', limitedOf() === undefined && limits.currentLimits.status === 'allowed')
  fresh()
  const control = usagePopupLine()
  check('the control: with no closed window the figures line is the account figures alone', control.endsWith('session 31% · week 56%'), control)
  check('…and the owner view carries no limited field', usage.usageForProvider('anthropic').limited === undefined)
  check('a window that binds every model never names a family', usage.limitBindsWords('five_hour', SONNET) === `binds every model, ${SONNET} among them` && usage.limitBindsWords('seven_day', SONNET).startsWith('binds every model'))
}

limits.__setAnthropicOwnerResolverForTest(null)
console.log(failures === 0 ? '\nprove-usage-per-model-window: all green' : `\nprove-usage-per-model-window: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
