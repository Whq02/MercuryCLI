#!/usr/bin/env bun
// ============================================================================
//  prove-usage-family-meters — /usage paints the account's per-family weekly
//  meters, the Fable bucket included.
//
//  The incident this closes: claude.ai showed "All models 51% · Fable 99%"
//  while /usage painted only the all-models week — the reader chained
//  opus ?? sonnet and never looked for the FABLE bucket, so a Fable account
//  saw no model-specific meter at all.
//
//    §1 THE SEAM — the armed fixture payload stands in for the wire and the
//       fetch returns it whole (fable intact) for a seeded subscriber.
//    §2 THE READER — the ONE owner walks the full per-family vocabulary
//       (the folded fixture answers Fable and Opus, no Sonnet: a pool the
//       endpoint did not state is absent, never 0%) and the panel paints
//       every stated pool through that owner, titled by its label; the
//       family-subset chain is ABSENT (the poison: `seven_day_opus ??
//       seven_day_sonnet` skipped fable), and so is any second decode of
//       the fetch response.
//    §3 THE SUBSCRIBER — the seeded max subscriber reads as the fetch gate.
//
//  The render truth (both sizes) is the built-bundle /usage capture driven
//  with this same armed payload.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-usage-family-meters.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'usage-family-meters-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// The seeded subscriber: a claude.ai max account whose token carries the
// inference + profile scopes and a far future expiry (file store).
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

// The armed fixture payload — the operator's own claude.ai numbers.
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

//
section('§1 — the seam: the armed payload stands in for the wire, whole')
//
{
  const { mockUtilizationPayload } = await import('../../src/services/mockRateLimits.ts')
  const armed = mockUtilizationPayload()
  check('the armed seam parses the payload', armed !== null, JSON.stringify(armed))
  check('…fable bucket intact at 99', armed?.seven_day_fable?.utilization === 99)

  const { fetchUtilization } = await import('../../src/services/api/usage.ts')
  const fetched = await fetchUtilization()
  check('fetchUtilization answers the fixture payload with ZERO network', fetched !== null, JSON.stringify(fetched))
  check('…all-models week at 51', fetched?.seven_day?.utilization === 51)
  check('…the FABLE bucket rides the answer at 99 (the missing meter)', fetched?.seven_day_fable?.utilization === 99)
  check('…the opus bucket rides at 12', fetched?.seven_day_opus?.utilization === 12)

  delete process.env.MERCURY_MOCK_LIMITS
  const folded = mockUtilizationPayload()
  check('the unarmed seam folds shut (null — the wire would answer)', folded === null)
  process.env.MERCURY_MOCK_LIMITS = '1'
}

//
section('§2 — the one owner walks the full per-family vocabulary; the panel reads it')
//
{
  // The fetch above folded the fixture into the one record: the owner's
  // pool view carries exactly what the endpoint stated.
  const { anthropicPoolWindowViews } = await import('../../src/services/providers/providerUsage.ts')
  const { WEEKLY_POOL_CLAIMS } = await import('../../src/services/claudeAiLimits.ts')
  check('the owner\'s vocabulary lists every pooled family (fable included)', WEEKLY_POOL_CLAIMS.join(',') === 'seven_day_fable,seven_day_opus,seven_day_sonnet')
  const pools = anthropicPoolWindowViews()
  const byKey = Object.fromEntries(pools.map(p => [p.key, Math.round(p.usedPct ?? -1)]))
  check('the owner reads the FABLE pool at 99', byKey.seven_day_fable === 99, JSON.stringify(byKey))
  check('…and the Opus pool at 12', byKey.seven_day_opus === 12, JSON.stringify(byKey))
  check('…and the Sonnet pool the endpoint never stated is ABSENT (never 0%)', !('seven_day_sonnet' in byKey), JSON.stringify(byKey))
  check('every pool names its feed (endpoint-fed) and carries its stamp', pools.every(p => p.source === 'endpoint' && typeof p.observedAtMs === 'number'))

  const src = readFileSync(join(import.meta.dir, '../../src/components/Settings/Usage.tsx'), 'utf8')
  // The poison, composed at runtime so this file never spells it as live code:
  // the family-subset chain that skipped the fable bucket.
  const poisonChain = ['data.seven_day_opus ', '?? data.seven_day_sonnet'].join('')
  check('the family-subset ??-chain is GONE from the panel', !src.includes(poisonChain))
  check('the panel reads the pools through the owner\'s pool view', src.includes('anthropicPoolWindowViews()'))
  check('no second decode of the fetch response survives in the panel', !src.includes('data.seven_day_'))
  check('each painted pool row is titled by its label', src.includes('`Current week (${w.label})`'))
  check('no plan word gates a stated pool off the panel', !src.includes('showModelSpecific'))
}

//
section('§3 — the seeded subscriber passes the fetch gate')
//
{
  const auth = await import('../../src/utils/auth.ts')
  check('the seeded home reads as a claude.ai subscriber', auth.isClaudeAISubscriber() === true)
  check('…with the profile scope (the fetch gate)', auth.hasProfileScope() === true)
  check('…on the max plan (the seeded custodian word)', auth.getSubscriptionType() === 'max')
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(failures === 0 ? '\n✅ prove-usage-family-meters — all checks pass' : '\n❌ prove-usage-family-meters — check(s) failed')
process.exit(failures)
