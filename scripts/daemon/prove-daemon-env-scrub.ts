#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' daemon env scrub — no pinned spawner token (HB-0078)')
console.log('============================================================')

section('source: spawnOwnedDaemon scrubs the pinned auth vars (guarded by a fallback)')
const FOREIGN = ['CLAUDE', 'CODE'].join('_')

section('source: auth resolution has an env→keychain fallback (so scrub is safe)')
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
const heldToken = process.env.MERCURY_OAUTH_TOKEN
process.env.MERCURY_OAUTH_TOKEN = 'env-scrub-proof-token'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
const { getClaudeAIOAuthTokens, getClaudeAIOAuthTokensAsync } = await import('../../src/models/sign-in/credentials/auth.ts')
const viaSync = getClaudeAIOAuthTokens()
const viaAsync = await getClaudeAIOAuthTokensAsync()
if (heldToken === undefined) delete process.env.MERCURY_OAUTH_TOKEN
else process.env.MERCURY_OAUTH_TOKEN = heldToken
check('getClaudeAIOAuthTokens answers the token of the environment before any store', viaSync?.accessToken === 'env-scrub-proof-token', JSON.stringify(viaSync?.accessToken ?? null), 'change getClaudeAIOAuthTokens in src/models/sign-in/credentials/auth.ts so a MERCURY_OAUTH_TOKEN in the environment is answered first')
check('getClaudeAIOAuthTokensAsync answers the token of the environment before any store', viaAsync?.accessToken === 'env-scrub-proof-token', JSON.stringify(viaAsync?.accessToken ?? null), 'change getClaudeAIOAuthTokensAsync in src/models/sign-in/credentials/auth.ts so a MERCURY_OAUTH_TOKEN in the environment is answered first')

section('behavioural mirror: the scrub removes the pinned vars (guard true) / keeps (false)')
const AUTH_VARS = ['MERCURY_OAUTH_TOKEN', `${FOREIGN}_OAUTH_TOKEN`, `${FOREIGN}_SUBSCRIPTION_TYPE`, `${FOREIGN}_RATE_LIMIT_TIER`, 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', `${FOREIGN}_OAUTH_TOKEN_FILE_DESCRIPTOR`]
const buildDaemonEnv = (parentEnv: Record<string, string>, hasKeychain: boolean): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...parentEnv, MERCURY_DAEMON_OWNER_PID: '123' }
  if (hasKeychain) for (const k of AUTH_VARS) delete env[k]
  return env
}
const parent = { PATH: '/usr/bin', HOME: '/home/u', MERCURY_OAUTH_TOKEN: 'SECRET-M', [`${FOREIGN}_OAUTH_TOKEN`]: 'SECRET-A', [`${FOREIGN}_SUBSCRIPTION_TYPE`]: 'pro', [`${FOREIGN}_RATE_LIMIT_TIER`]: 't1', CODEX_API_KEY: 'SECRET-C', MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR: '7', [`${FOREIGN}_OAUTH_TOKEN_FILE_DESCRIPTOR`]: '8' }
const scrubbed = buildDaemonEnv(parent, true)
check('keychain present ⇒ OAuth token (both spellings) scrubbed from daemon env', scrubbed.MERCURY_OAUTH_TOKEN === undefined && scrubbed[`${FOREIGN}_OAUTH_TOKEN`] === undefined)
check('keychain present ⇒ every table row session spelling scrubbed (the derived surface, codex row included)', scrubbed.CODEX_API_KEY === undefined)
check('keychain present ⇒ subscription/tier/FD (both spellings) also scrubbed', scrubbed[`${FOREIGN}_SUBSCRIPTION_TYPE`] === undefined && scrubbed[`${FOREIGN}_RATE_LIMIT_TIER`] === undefined && scrubbed.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR === undefined && scrubbed[`${FOREIGN}_OAUTH_TOKEN_FILE_DESCRIPTOR`] === undefined)
check('non-auth vars (PATH/HOME) are preserved', scrubbed.PATH === '/usr/bin' && scrubbed.HOME === '/home/u')
check('owner pid is still stamped', scrubbed.MERCURY_DAEMON_OWNER_PID === '123')
const kept = buildDaemonEnv(parent, false)
check('env-only auth (no keychain) ⇒ token KEPT (no fallback, no regression)', kept.MERCURY_OAUTH_TOKEN === 'SECRET-M')

section('the fresh-sign-in trigger: first-only, self-guarded, receipted by')
{
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const savedHome = { config: process.env.MERCURY_CONFIG_DIR, auth: process.env.MERCURY_AUTH_SCOPE_DIR }
  const home = mkdtempSync(join(tmpdir(), 'authverify-sf2-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_AUTH_SCOPE_DIR = home
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const ownedMod = await import('../../src/daemon/control/ownedDaemon.js')
  const { clearOAuthTokenCache } = await import('../../src/models/sign-in/lifecycle/oauthLifecycle.js')
  clearOAuthTokenCache()
  const asks: Array<{ op: string; by: string; proto: number }> = []
  const rpc = async (req: { op: 'restart-when-idle'; proto: number; by: string }): Promise<unknown> => {
    asks.push(req)
    return { ok: true, op: 'restart-when-idle', state: 'armed', live: 1 }
  }
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: false, spawnLabel: 'daemon' })
  check('no env-kept record ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 0, '', 'restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must return not-applicable and ask nothing when envKeptAuthAtSpawn is false')
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: true, spawnLabel: 'daemon' })
  check('env-kept record without a landed store ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 0, '', 'restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must return not-applicable until hasStoredOAuthToken() is true')
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
    { mode: 0o600 },
  )
  clearOAuthTokenCache()
  check(
    'the FIRST landed sign-in asks restart-when-idle with the receipt by-line',
    (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'asked' &&
      asks.length === 1 &&
      asks[0]!.op === 'restart-when-idle' &&
      asks[0]!.by === 'fresh sign-in after an env-kept spawn — the successor re-runs the credential scrub',
    JSON.stringify(asks),
    'restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must ask restart-when-idle once, with that by-line, when a stored sign-in lands after an env-kept spawn',
  )
  check('a second landing never asks again (one-shot latch)', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 1, '', 'restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must stay latched (freshSigninRestartAsked) after the first ask')
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: true, spawnLabel: null })
  check('a session that spawned no daemon ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 1, '', 'restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must return not-applicable while ownedSpawnLabelThisProcess is null')
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ spawnLabel: null })
  if (savedHome.config === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = savedHome.config
  if (savedHome.auth === undefined) delete process.env.MERCURY_AUTH_SCOPE_DIR
  else process.env.MERCURY_AUTH_SCOPE_DIR = savedHome.auth
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-ENV-SCRUB PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-ENV-SCRUB PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
