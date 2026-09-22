#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'verdict-latch-order-home-'))
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
const { quotaWindows } = await import('../../src/utils/cockpit/quota.ts')
const { APIError } = await import('@anthropic-ai/sdk')

auth.clearOAuthTokenCache()
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'at-live',
      refreshToken: 'rt-live',
      expiresAt: Date.now() + 7 * 24 * 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: null,
    },
  }),
)
auth.clearOAuthTokenCache()
const epoch = (msAhead: number): string => String(Math.floor((Date.now() + msAhead) / 1000))
const H = (entries: Record<string, string>): Headers => new Headers(entries)
const reset5h = epoch(2 * 3600_000)
const allowedHeaders = (): Headers =>
  H({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.40',
    'anthropic-ratelimit-unified-5h-reset': reset5h,
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
    'anthropic-ratelimit-unified-7d-reset': epoch(5 * 24 * 3600_000),
  })
const fiveHourPct = (): number => Math.round(quotaWindows().fiveHour.usedPct ?? -1)

console.log('============================================================')
console.log(" a reply's headers describe the state when the request began: an older reply never reopens a window a later verdict closed")
console.log('============================================================')

section('§0 the world: a signed-in subscriber, one reply observed, then the window refused')
limits.resetLimitsForCredentialSwitch()
check('the seeded sign-in reads as a subscriber', auth.isClaudeAISubscriber() === true)
const tFirst = Date.now() - 60_000
limits.extractQuotaStatusFromHeaders(allowedHeaders(), tFirst)
check('a reply stamped a minute ago arms the latch as allowed', limits.claudeWindowObserved() === true && limits.currentLimits.status === 'allowed', limits.currentLimits.status)
check("the verdict's moment is the request's own start, not the fold's clock", limits.anthropicLimitVerdict().observedAtMs === tFirst, JSON.stringify(limits.anthropicLimitVerdict()))
const refusedReset = epoch(90 * 60_000)
const refused = new APIError(
  429,
  { type: 'error', error: { type: 'rate_limit_error', message: 'the window is exhausted' } },
  undefined,
  H({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': refusedReset,
    'anthropic-ratelimit-unified-5h-utilization': '0.99',
    'anthropic-ratelimit-unified-5h-reset': reset5h,
  }) as never,
)
const beforeRefusal = Date.now()
limits.extractQuotaStatusFromError(refused)
const refusedAt = limits.anthropicLimitVerdict().observedAtMs ?? 0
check('the refusal latches rejected, observed at the refusal itself', limits.currentLimits.status === 'rejected' && refusedAt >= beforeRefusal, JSON.stringify(limits.anthropicLimitVerdict()))
check("the meters read the refusal's own window (5h 99%)", fiveHourPct() === 99, String(fiveHourPct()))

section('§1 a long reply that BEGAN before the refusal ends after it: its headers fold nothing')
const tOlder = refusedAt - 20_000
limits.extractQuotaStatusFromHeaders(allowedHeaders(), tOlder)
check('the verdict stays rejected', limits.currentLimits.status === 'rejected', limits.currentLimits.status)
check("the verdict's moment is still the refusal's", limits.anthropicLimitVerdict().observedAtMs === refusedAt, JSON.stringify(limits.anthropicLimitVerdict()))
check("the verdict still names the refusal's reset", limits.anthropicLimitVerdict().resetsAtMs === Number(refusedReset) * 1000, JSON.stringify(limits.anthropicLimitVerdict()))
check("the meters keep the refusal's window (5h 99%), never the older reply's 40%", fiveHourPct() === 99, String(fiveHourPct()))
check('the window stays observed', limits.claudeWindowObserved() === true)

section('§2 a reply that began AFTER the refusal speaks for the window again')
const tNewer = refusedAt + 1
limits.extractQuotaStatusFromHeaders(allowedHeaders(), tNewer)
check('the newer reply clears the refusal', limits.currentLimits.status === 'allowed', limits.currentLimits.status)
check("the verdict's moment is the newer request's start", limits.anthropicLimitVerdict().observedAtMs === tNewer, JSON.stringify(limits.anthropicLimitVerdict()))
check("the meters read the newer reply's window (5h 40%)", fiveHourPct() === 40, String(fiveHourPct()))
check('a reply stamped at the same instant as the standing verdict applies (ties never lose a fresh word)', (() => {
  limits.extractQuotaStatusFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed_warning', 'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9', 'anthropic-ratelimit-unified-5h-utilization': '0.91', 'anthropic-ratelimit-unified-5h-reset': reset5h }), tNewer)
  return limits.currentLimits.status === 'allowed_warning'
})(), limits.currentLimits.status)

section("§3 the relay carries the request's moment, and adopts only what is newer")
const fact = limits.anthropicWindowFact()
check("the relayed fact's moment is the standing verdict's", fact !== undefined && fact.observedAtMs === tNewer, JSON.stringify(fact))
check('a relayed fact older than the standing verdict is refused', fact !== undefined && limits.adoptAnthropicWindowFact({ ...fact, status: 'rejected', observedAtMs: tOlder }) === false)
check('…and the verdict is unmoved by it', limits.currentLimits.status === 'allowed_warning', limits.currentLimits.status)
check('a relayed fact newer than the standing verdict is adopted', fact !== undefined && limits.adoptAnthropicWindowFact({ ...fact, status: 'rejected', observedAtMs: tNewer + 5_000 }) === true && limits.currentLimits.status === 'rejected', limits.currentLimits.status)

section('§4 a fold with no stamp reads as now, so every caller that says nothing keeps the old road')
limits.resetLimitsForCredentialSwitch()
const beforeBare = Date.now()
limits.extractQuotaStatusFromHeaders(allowedHeaders())
const bare = limits.anthropicLimitVerdict().observedAtMs ?? 0
check('an unstamped fold is observed at the fold itself', bare >= beforeBare && bare <= Date.now(), String(bare))

section("§5 the wire road hands the latch the request's own start (source pin)")
const stream = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
check("the stream road folds the streaming response's headers with the attempt's start", stream.includes('extractQuotaStatusFromHeaders(resp.headers, start)'))

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-anthropic-verdict-latch-order — ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
