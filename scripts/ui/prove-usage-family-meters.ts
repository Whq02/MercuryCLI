#!/usr/bin/env bun
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

section('§1 — the seam: the armed payload stands in for the wire, whole')
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

section('§2 — the reader walks the full per-family vocabulary')
{
  const src = readFileSync(join(import.meta.dir, '../../src/components/Settings/Usage.tsx'), 'utf8')
  const poisonChain = ['data.seven_day_opus ', '?? data.seven_day_sonnet'].join('')
  check('the family-subset ??-chain is GONE from the reader', !src.includes(poisonChain))
  check('the reader reads the FABLE bucket', src.includes('seven_day_fable'))
  for (const family of ['Fable', 'Opus', 'Sonnet']) {
    check(`the row walk lists ${family}`, src.includes(`['${family}', data.seven_day_${family.toLowerCase()}]`))
  }
  check('each painted row is titled by its family', src.includes('`Current week (${family})`'))
}

section('§3 — the seeded subscriber gates the model-specific rows on')
{
  const auth = await import('../../src/utils/auth.ts')
  check('the seeded home reads as a claude.ai subscriber', auth.isClaudeAISubscriber() === true)
  check('…with the profile scope (the fetch gate)', auth.hasProfileScope() === true)
  check('…on the max plan (the model-specific gate)', auth.getSubscriptionType() === 'max')
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-usage-family-meters — all checks pass' : '\n❌ prove-usage-family-meters — check(s) failed')
process.exit(failures)
