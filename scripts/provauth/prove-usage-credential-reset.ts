#!/usr/bin/env bun
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

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
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
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/oauth'

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

const limits = await import('../../src/models/roads/anthropic/anthropicLimits.js')

const WINDOWS = {
  five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() },
  seven_day: { utilization: 17, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
}

const windowsPainted = (): boolean => {
  const raw = limits.getRawUtilization()
  return raw.five_hour !== undefined && raw.seven_day !== undefined
}

section('§1 one reset call empties every usage feeder and bumps the epoch')
{
  limits.foldUtilizationFromEndpoint(WINDOWS)
  check('seed: endpoint windows painted', windowsPainted(), 'foldUtilizationFromEndpoint in src/models/roads/anthropic/anthropicLimits.ts did not fill rawUtilization for the five_hour and seven_day windows')
  const epochBefore = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch()
  check('reset: windows emptied', !windowsPainted(), 'resetLimitsForCredentialSwitch in src/models/roads/anthropic/anthropicLimits.ts must clear rawUtilization and endpointUtilization')
  check('reset: epoch bumped by one', limits.getUsageCredentialEpoch() === epochBefore + 1, 'resetLimitsForCredentialSwitch in src/models/roads/anthropic/anthropicLimits.ts must increment usageCredentialEpoch exactly once per call')
  check(
    'reset: the limits singleton settles to default',
    limits.currentLimits.status === 'allowed' && limits.currentLimits.resetsAt === undefined,
    'resetLimitsForCredentialSwitch in src/models/roads/anthropic/anthropicLimits.ts must emit DEFAULT_LIMITS through emitStatusChange when currentLimits differs',
  )
}

section('§2 an observation from a departed epoch folds nowhere; a current one lands')
{
  const issued = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint(WINDOWS, issued)
  check('stale fold refused: windows stay empty', !windowsPainted(), 'foldUtilizationFromEndpoint in src/models/roads/anthropic/anthropicLimits.ts must return early when issuedEpoch differs from usageCredentialEpoch')
  const fresh = limits.getUsageCredentialEpoch()
  limits.foldUtilizationFromEndpoint(WINDOWS, fresh)
  check('current-epoch fold lands: windows painted', windowsPainted(), 'foldUtilizationFromEndpoint in src/models/roads/anthropic/anthropicLimits.ts must fold when issuedEpoch equals usageCredentialEpoch')
  const epochless = limits.getUsageCredentialEpoch()
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint(WINDOWS)
  check(
    'an epoch-less fold still lands (only STALE-tagged observations refuse)',
    windowsPainted() && limits.getUsageCredentialEpoch() === epochless + 1,
    'foldUtilizationFromEndpoint in src/models/roads/anthropic/anthropicLimits.ts must fold when issuedEpoch is undefined; only a defined, stale epoch may refuse',
  )
}

section('§3 a DIFFERENT account signing in resets; a same-account refresh never does')
{
  const { saveGlobalConfig } = await import('../../src/platform/settings/config.js')
  const { storeOAuthAccountInfo } = await import('../../src/models/sign-in/oauth/client.js')
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
  check('same account, changed field: windows survive', windowsPainted(), 'storeOAuthAccountInfo in src/models/sign-in/oauth/refresh.ts must call resetLimitsForCredentialSwitch only when existing.accountUuid differs from info.accountUuid')
  check('same account: epoch unchanged', limits.getUsageCredentialEpoch() === epochBefore, 'storeOAuthAccountInfo in src/models/sign-in/oauth/refresh.ts must not reset the limits when the accountUuid is unchanged')
  storeOAuthAccountInfo({
    accountUuid: 'acct-B',
    emailAddress: 'b@fixture.invalid',
  } as never)
  check('different account: windows emptied', !windowsPainted(), 'storeOAuthAccountInfo in src/models/sign-in/oauth/refresh.ts must call resetLimitsForCredentialSwitch when the accountUuid changes')
  check('different account: epoch bumped', limits.getUsageCredentialEpoch() === epochBefore + 1, 'storeOAuthAccountInfo in src/models/sign-in/oauth/refresh.ts must reset the limits exactly once when the accountUuid changes')
}

section('§4 performLogout empties the usage truth (reset lands before any faulting leg)')
{
  limits.foldUtilizationFromEndpoint(WINDOWS)
  check('seed: windows painted again', windowsPainted(), 'foldUtilizationFromEndpoint in src/models/roads/anthropic/anthropicLimits.ts did not fill rawUtilization')
  const { performLogout } = await import('../../src/commands/logout/logout.js')
  try {
    await performLogout()
  } catch {
  }
  check('after /logout: windows emptied', !windowsPainted(), 'performLogout in src/commands/logout/logout.tsx must call resetLimitsForCredentialSwitch before any step that can throw')
}

console.log(
  failures === 0 ? '\nALL GREEN (usage credential reset)' : `\n${failures} FAILURES`,
)
process.exit(failures === 0 ? 0 : 1)
