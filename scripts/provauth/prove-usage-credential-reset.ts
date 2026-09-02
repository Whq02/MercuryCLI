#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-usage-credential-reset.ts — LANE IV: the usage
//  credential reset FIRES in the product, and an in-flight observation can
//  never repaint a departed account.
//
//  What lane IV found on the landed usage-truth estate:
//   · resetLimitsForCredentialSwitch existed with ZERO production callers —
//     the one-truth clear was proven as a function and wired nowhere: a live
//     sign-out/switch left the window feeders painted with the departed
//     account's meters.
//   · fetchUtilization folded its answer unconditionally after a 5-second
//     await — a sign-out landing inside that window was immediately
//     repainted by the stale response (the zombie-usage race).
//
//  The laws under proof, over the REAL owners on a scratch home:
//   §1 the composite reset: one call empties the header feeder and the
//      endpoint feeder, settles the limits singleton, and bumps the
//      credential epoch.
//   §2 stale-by-credential refusal at the fold: an observation carrying a
//      departed epoch lands nowhere; the current epoch still lands (a fresh
//      session's meters fill normally).
//   §3 the switch site fires: storeOAuthAccountInfo with a DIFFERENT
//      accountUuid resets; a same-account field refresh never resets.
//   §4 the /logout site fires: performLogout empties the usage truth even
//      when a later teardown leg faults.
//
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-usage-credential-reset.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' PROVAUTH — the usage credential reset fires, and stale folds refuse')
console.log('============================================================')

// ── hermetic ground ─────────────────────────────────────────────────────────
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'MERCURY_USAGE_SEED',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
const scratchHome = mkdtempSync(join(tmpdir(), 'prove-usage-credential-reset-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
// Any accidental network leg fails loud on a non-resolvable host.
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/oauth'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const limits = await import('../../src/services/claudeAiLimits.js')

const WINDOWS = {
  five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() },
  seven_day: { utilization: 17, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
}

const windowsPainted = (): boolean => {
  const raw = limits.getRawUtilization()
  return raw.five_hour !== undefined && raw.seven_day !== undefined
}

// ── §1 the composite reset ──────────────────────────────────────────────────
section('§1 one reset call empties every usage feeder and bumps the epoch')
{
  limits.foldUtilizationFromEndpoint(WINDOWS)
  check('seed: endpoint windows painted', windowsPainted())
  const epochBefore = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch()
  check('reset: windows emptied', !windowsPainted())
  check('reset: epoch bumped by one', limits.getUsageCredentialEpoch() === epochBefore + 1)
  check(
    'reset: the limits singleton settles to default',
    limits.currentLimits.status === 'allowed' && limits.currentLimits.resetsAt === undefined,
  )
}

// ── §2 stale-by-credential refusal at both folds ────────────────────────────
section('§2 an observation from a departed epoch folds nowhere; a current one lands')
{
  const issued = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch() // the account changed mid-flight
  limits.foldUtilizationFromEndpoint(WINDOWS, issued)
  check('stale fold refused: windows stay empty', !windowsPainted())
  const fresh = limits.getUsageCredentialEpoch()
  limits.foldUtilizationFromEndpoint(WINDOWS, fresh)
  check('current-epoch fold lands: windows painted', windowsPainted())
  const epochless = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint(WINDOWS) // epoch-less caller (legacy shape)
  check(
    'an epoch-less fold still lands (only STALE-tagged observations refuse)',
    windowsPainted() && limits.getUsageCredentialEpoch() === epochless + 1,
  )
}

// ── §3 the switch site: storeOAuthAccountInfo ───────────────────────────────
section('§3 a DIFFERENT account signing in resets; a same-account refresh never does')
{
  const { saveGlobalConfig } = await import('../../src/utils/config.js')
  const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.js')
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: { accountUuid: 'acct-A', emailAddress: 'a@fixture.invalid' },
  }))
  limits.foldUtilizationFromEndpoint(WINDOWS)
  const epochBefore = limits.getUsageCredentialEpoch()
  storeOAuthAccountInfo({
    accountUuid: 'acct-A',
    emailAddress: 'a-renamed@fixture.invalid',
  } as never)
  check('same account, changed field: windows survive', windowsPainted())
  check('same account: epoch unchanged', limits.getUsageCredentialEpoch() === epochBefore)
  storeOAuthAccountInfo({
    accountUuid: 'acct-B',
    emailAddress: 'b@fixture.invalid',
  } as never)
  check('different account: windows emptied', !windowsPainted())
  check('different account: epoch bumped', limits.getUsageCredentialEpoch() === epochBefore + 1)
}

// ── §4 the /logout site ─────────────────────────────────────────────────────
section('§4 performLogout empties the usage truth (reset lands before any faulting leg)')
{
  limits.foldUtilizationFromEndpoint(WINDOWS)
  check('seed: windows painted again', windowsPainted())
  const { performLogout } = await import('../../src/commands/logout/logout.js')
  try {
    await performLogout()
  } catch {
    // A teardown leg may fault on the hermetic ground — the reset must have
    // landed regardless (it runs before the cache-refresh legs).
  }
  check('after /logout: windows emptied', !windowsPainted())
}

console.log(
  failures === 0 ? '\nALL GREEN (usage credential reset)' : `\n${failures} FAILURES`,
)
process.exit(failures === 0 ? 0 : 1)
