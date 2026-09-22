#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'latch-headers-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_MOCK_LIMITS
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const mocking = await import('../../src/services/rateLimitMocking.ts')
const { quotaWindows } = await import('../../src/utils/cockpit/quota.ts')
const { APIError } = await import('@anthropic-ai/sdk')

const credsPath = join(HOME, '.credentials.json')
const seed = (oauth: Record<string, unknown> | null): void => {
  auth.clearOAuthTokenCache()
  writeFileSync(credsPath, JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }))
  auth.clearOAuthTokenCache()
}
const SUBSCRIBER = {
  accessToken: 'at-live',
  refreshToken: 'rt-live',
  expiresAt: Date.now() + 7 * 24 * 3600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: null,
}
const epoch = (msAhead: number): string => String(Math.floor((Date.now() + msAhead) / 1000))
const H = (entries: Record<string, string>): Headers => new Headers(entries)

console.log('============================================================')
console.log(" the Anthropic latch arms from a response's own headers — the runner's wire road, no fixture seam")
console.log('============================================================')

section('§0 the world: a signed-in subscriber, the fixture seam unarmed, nothing observed yet')
{
  seed(SUBSCRIBER)
  check('the seeded sign-in reads as a subscriber', auth.isClaudeAISubscriber() === true)
  check('the fixture seam is not armed, so the headers a response carries are the ones read', mocking.shouldProcessMockLimits() === false)
  limits.resetLimitsForCredentialSwitch()
  check('before any response has spoken the window is unobserved', limits.claudeWindowObserved() === false)
  const v = limits.anthropicLimitVerdict()
  check("…and the verdict reads the default 'allowed' with no moment", v.status === 'allowed' && v.observedAtMs === undefined, JSON.stringify(v))
}

section("§1 a clean response arms the latch from its own headers")
const reset5h = epoch(2 * 3600_000)
{
  limits.extractQuotaStatusFromHeaders(
    H({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': reset5h,
      'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': epoch(5 * 24 * 3600_000),
    }),
  )
  check('the window is observed once a response has spoken', limits.claudeWindowObserved() === true)
  check("the record reads the header's status (allowed)", limits.currentLimits.status === 'allowed', limits.currentLimits.status)
  const v = limits.anthropicLimitVerdict()
  check('the verdict carries the moment of the observation', v.status === 'allowed' && typeof v.observedAtMs === 'number' && Date.now() - v.observedAtMs < 5_000, JSON.stringify(v))
  const w = quotaWindows()
  check(
    "the meters read the response's own windows (5h 42% · 7d 12%)",
    w.fiveHour.state === 'live' && Math.round(w.fiveHour.usedPct ?? -1) === 42 && w.sevenDay.state === 'live' && Math.round(w.sevenDay.usedPct ?? -1) === 12,
    JSON.stringify(w),
  )
}

section('§2 a warning response moves the record and keeps it observed')
{
  limits.extractQuotaStatusFromHeaders(
    H({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
      'anthropic-ratelimit-unified-5h-utilization': '0.91',
      'anthropic-ratelimit-unified-5h-reset': reset5h,
      'anthropic-ratelimit-unified-reset': reset5h,
    }),
  )
  check('the surpassed-threshold header reads as allowed_warning on the five-hour window', limits.currentLimits.status === 'allowed_warning' && limits.currentLimits.rateLimitType === 'five_hour', JSON.stringify(limits.currentLimits))
  const v = limits.anthropicLimitVerdict()
  check("the verdict names the header's reset", v.resetsAtMs === Number(reset5h) * 1000, JSON.stringify(v))
  check('the window stays observed', limits.claudeWindowObserved() === true)
}

section('§3 a refused response (429) latches rejected through the error road')
{
  const resetRejected = epoch(90 * 60_000)
  const refused = new APIError(
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'the window is exhausted' } },
    undefined,
    H({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': resetRejected }) as never,
  )
  limits.extractQuotaStatusFromError(refused)
  check('the record reads rejected', limits.currentLimits.status === 'rejected', limits.currentLimits.status)
  const v = limits.anthropicLimitVerdict()
  check("the verdict names the 429's reset and the account", v.status === 'rejected' && v.resetsAtMs === Number(resetRejected) * 1000 && typeof v.account === 'string', JSON.stringify(v))
  check('the window stays observed', limits.claudeWindowObserved() === true)
}

section('§4 a credential move forgets the observation; the next response arms it again')
{
  limits.resetLimitsForCredentialSwitch()
  const v = limits.anthropicLimitVerdict()
  check('after the switch nothing is observed', limits.claudeWindowObserved() === false && v.observedAtMs === undefined, JSON.stringify(v))
  limits.extractQuotaStatusFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed' }))
  check('the next response arms the latch again', limits.claudeWindowObserved() === true && limits.currentLimits.status === 'allowed')
}

section('§5 the subscriber gate: a response for a session with no sign-in clears the record instead of arming it')
{
  seed(null)
  check('no sign-in reads as no subscriber', auth.isClaudeAISubscriber() === false)
  limits.extractQuotaStatusFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed_warning' }))
  check('the gate closed: the window is unobserved and the record is the default', limits.claudeWindowObserved() === false && limits.currentLimits.status === 'allowed', limits.currentLimits.status)
  seed(SUBSCRIBER)
}

section('§6 the wire road hands the latch what it reads, and the seam never stands in for it (source pins)')
{
  const stream = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check("the stream road hands the streaming response's headers to the latch", stream.includes('extractQuotaStatusFromHeaders(resp.headers, start)'))
  check('…and a refused turn to the error road', stream.includes('extractQuotaStatusFromError(error)'))
  const seam = readFileSync(join(ROOT, 'src/commands/mock-limits/index.ts'), 'utf8')
  check("the fixture seam is a screen-seat command, so its scenarios arm the screen's latch and never the runner's wire road", /seat:\s*'screen'/.test(seam))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-anthropic-latch-from-headers — ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
