#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'usage-family-meters-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-token',
      refreshToken: 'fixture-refresh-token',
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  }),
)

const PAYLOAD = {
  five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3600e3).toISOString() },
  seven_day: { utilization: 51, resets_at: new Date(Date.now() + 5 * 24 * 3600e3).toISOString() },
  seven_day_fable: { utilization: 99, resets_at: new Date(Date.now() + 5 * 24 * 3600e3).toISOString() },
  seven_day_opus: { utilization: 12, resets_at: new Date(Date.now() + 5 * 24 * 3600e3).toISOString() },
}
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.MERCURY_MOCK_USAGE_PAYLOAD = JSON.stringify(PAYLOAD)

console.log('============================================================')
console.log(' usage family meters — the Fable week paints beside all-models')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

section('§1 — the seam: the armed payload stands in for the wire, whole')
{
  const { mockUtilizationPayload } = await import('../../src/models/roads/anthropic/mockRateLimits.ts')
  const armed = mockUtilizationPayload()
  check('the armed seam parses the payload', armed !== null, JSON.stringify(armed) + ' — mockUtilizationPayload in src/models/roads/anthropic/mockRateLimits.ts must parse MERCURY_MOCK_USAGE_PAYLOAD when MERCURY_MOCK_LIMITS is 1')
  check('…fable bucket intact at 99', armed?.seven_day_fable?.utilization === 99, `seven_day_fable=${JSON.stringify(armed?.seven_day_fable)} — mockUtilizationPayload in src/models/roads/anthropic/mockRateLimits.ts must pass the seven_day_fable bucket through unchanged`)

  const { fetchUtilization } = await import('../../src/models/usage/anthropicUsageFetch.ts')
  const fetched = await fetchUtilization()
  check('fetchUtilization answers the fixture payload with ZERO network', fetched !== null, JSON.stringify(fetched) + ' — fetchUtilization in src/models/usage/anthropicUsageFetch.ts must return mockUtilizationPayload() before any request when it is non-null')
  check('…all-models week at 51', fetched?.seven_day?.utilization === 51, `seven_day=${JSON.stringify(fetched?.seven_day)} — fetchUtilization in src/models/usage/anthropicUsageFetch.ts must return the armed payload whole`)
  check('…the FABLE bucket rides the answer at 99 (the missing meter)', fetched?.seven_day_fable?.utilization === 99, `seven_day_fable=${JSON.stringify(fetched?.seven_day_fable)} — fetchUtilization in src/models/usage/anthropicUsageFetch.ts must not drop the seven_day_fable bucket`)
  check('…the opus bucket rides at 12', fetched?.seven_day_opus?.utilization === 12, `seven_day_opus=${JSON.stringify(fetched?.seven_day_opus)} — fetchUtilization in src/models/usage/anthropicUsageFetch.ts must not drop the seven_day_opus bucket`)

  delete process.env.MERCURY_MOCK_LIMITS
  const folded = mockUtilizationPayload()
  check('the unarmed seam folds shut (null — the wire would answer)', folded === null, `got ${JSON.stringify(folded)} — mockUtilizationPayload in src/models/roads/anthropic/mockRateLimits.ts must return null unless MERCURY_MOCK_LIMITS is 1`)
  process.env.MERCURY_MOCK_LIMITS = '1'
}

section('§2 — the one owner walks the full per-family vocabulary; the panel reads it')
{
  const { anthropicPoolWindowViews } = await import('../../src/models/roads/providerUsage.ts')
  const { WEEKLY_POOL_CLAIMS } = await import('../../src/models/roads/anthropic/anthropicLimits.ts')
  check('the owner\'s vocabulary lists every pooled family (fable included)', WEEKLY_POOL_CLAIMS.join(',') === 'seven_day_fable,seven_day_opus,seven_day_sonnet', `got ${WEEKLY_POOL_CLAIMS.join(',')} — WEEKLY_POOL_CLAIMS in src/models/roads/anthropic/anthropicLimits.ts must list every pooled family`)
  const pools = anthropicPoolWindowViews()
  const byKey = Object.fromEntries(pools.map(p => [p.key, Math.round(p.usedPct ?? -1)]))
  check('the owner reads the FABLE pool at 99', byKey.seven_day_fable === 99, JSON.stringify(byKey) + ' — anthropicPoolWindowViews in src/models/roads/providerUsage.ts must return a seven_day_fable window from the fetched payload')
  check('…and the Opus pool at 12', byKey.seven_day_opus === 12, JSON.stringify(byKey) + ' — anthropicPoolWindowViews in src/models/roads/providerUsage.ts')
  check('…and the Sonnet pool the endpoint never stated is ABSENT (never 0%)', !('seven_day_sonnet' in byKey), JSON.stringify(byKey) + ' — anthropicPoolWindowViews in src/models/roads/providerUsage.ts must skip a pool the endpoint did not state')
  check('every pool names its feed (endpoint-fed) and carries its stamp', pools.every(p => p.source === 'endpoint' && typeof p.observedAtMs === 'number'), JSON.stringify(pools.map(p => ({ key: p.key, source: p.source, observedAtMs: p.observedAtMs }))) + ' — anthropicPoolWindowViews in src/models/roads/providerUsage.ts must set source to endpoint and observedAtMs on every pool it returns')

}

section('§3 — the seeded subscriber passes the fetch gate')
{
  const auth = await import('../../src/models/sign-in/credentials/auth.ts')
  check('the seeded home reads as a claude.ai subscriber', auth.isClaudeAISubscriber() === true, 'isClaudeAISubscriber in src/models/sign-in/credentials/auth.ts must read the seeded claudeAiOauth entry in .credentials.json under MERCURY_CONFIG_DIR')
  check('…with the profile scope (the fetch gate)', auth.hasProfileScope() === true, 'hasProfileScope in src/models/sign-in/credentials/auth.ts must find user:profile in the seeded scopes')
  check('…on the max plan (the seeded custodian word)', auth.getSubscriptionType() === 'max', `got ${auth.getSubscriptionType()} — getSubscriptionType in src/models/sign-in/credentials/auth.ts must read subscriptionType from the seeded credentials`)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-usage-family-meters — all checks pass' : '\n❌ prove-usage-family-meters — check(s) failed')
process.exit(failures)
