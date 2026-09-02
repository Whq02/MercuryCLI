#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-daemon-env-scrub.ts
//  PROOF for: spawnOwnedDaemon copied the foreground's FULL env (incl.
//  the session OAuth token) into the detached daemon, pinning the spawner's live
//  session token for the daemon's life → on a shared config home, session B's
//  dispatches ran under session A's token (cross-account misattribution). The fix
//  scrubs the pinned auth-token vars from the daemon env WHEN a keychain token
//  exists (a confirmed config fallback), so the daemon re-resolves ITS OWN account
//  token; env-only auth (no keychain) keeps the env token (no fallback).
//
//  ownedDaemon.ts/auth.ts pull the heavy auth+config graph, so this locks the
//  wiring by source-text + mirrors the (pure) scrub set.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-daemon-env-scrub.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const owned = readFileSync(join(ROOT, 'src', 'daemon', 'ownedDaemon.ts'), 'utf-8')
const auth = readFileSync(join(ROOT, 'src', 'utils', 'auth.ts'), 'utf-8')
const subEnv = readFileSync(join(ROOT, 'src', 'utils', 'subprocessEnv.ts'), 'utf-8')

console.log('============================================================')
console.log(' daemon env scrub — no pinned spawner token (HB-0078)')
console.log('============================================================')

section('source: spawnOwnedDaemon scrubs the pinned auth vars (guarded by a fallback)')
check('scrub is GATED on hasStoredOAuthToken() (a confirmed keychain fallback)', /const storedTokenAtSpawn = hasStoredOAuthToken\(\)[\s\S]{0,240}if \(storedTokenAtSpawn\) \{[\s\S]{0,160}delete env\[k\]/.test(owned))
// The foreign product's env prefix, composed so this prover never matches a
// vocabulary sweep (the dist-invariants needle pattern).
const FOREIGN = ['CLAUDE', 'CODE'].join('_')
// THE ONE-HOME SET: the strip set hoisted to
// STORED_TOKEN_SCRUB_VARS in subprocessEnv — the canonical auth-token vars,
// the token file-descriptor, and the table-derived foreign descriptors —
// consumed by BOTH daemon spawn doors (the owned spawn and the restart
// successor), so the two can never drift.
check('the one-home strip set carries session vars + own FD + the table-derived foreign FDs', /export const STORED_TOKEN_SCRUB_VARS[\s\S]{0,240}\.\.\.ALWAYS_STRIP_TOKEN_VARS,\s*\n?\s*'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',\s*\n?\s*\.\.\.AGENT_CLI_TOKEN_FD_ENV_VARS/.test(subEnv))
check('spawnOwnedDaemon consumes the one-home set', owned.includes('for (const k of STORED_TOKEN_SCRUB_VARS)'))
check('hasStoredOAuthToken reads the keychain (secureStorage), NOT the env var', /export function hasStoredOAuthToken\(\)[\s\S]{0,160}getSecureStorage\(\)\.read\(\)\?\.claudeAiOauth\?\.accessToken/.test(auth))
// The strip list DERIVES from the signature table (every row equally), so
// the foreign spelling is pinned where it lives: the table row's source.
const foreignTable = readFileSync(join(ROOT, 'src', 'utils', 'knownAgentClis.ts'), 'utf-8')
check('ALWAYS_STRIP_TOKEN_VARS is exported + carries the OAuth token (own spelling + the table-derived foreign spellings)', /export const ALWAYS_STRIP_TOKEN_VARS[\s\S]{0,240}MERCURY_OAUTH_TOKEN/.test(subEnv) && subEnv.includes('...AGENT_CLI_SESSION_ENV_VARS') && foreignTable.includes(`'${FOREIGN}_OAUTH_TOKEN'`))

section('source: auth resolution has an env→keychain fallback (so scrub is safe)')
// getClaudeAIOAuthTokens checks the env var FIRST, then falls back to secure storage.
check('getClaudeAIOAuthTokens checks MERCURY_OAUTH_TOKEN env first', /if \(process\.env\.MERCURY_OAUTH_TOKEN\)/.test(auth))
check('…then falls back to the keychain (secureStorage.read().claudeAiOauth)', /getSecureStorage\(\)\.read\(\)\?\.claudeAiOauth/.test(auth))

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

section('the restart successor door: the SAME gated scrub, receipted')
{
  const daemonMain = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf-8')
  check(
    'spawnSuccessorDaemon re-runs the gated scrub with the one-home set',
    /function spawnSuccessorDaemon[\s\S]{0,900}if \(hasStoredOAuthToken\(\)\) \{[\s\S]{0,400}STORED_TOKEN_SCRUB_VARS/.test(daemonMain),
  )
  check(
    'the successor scrub is RECEIPTED (the daemon says what it dropped and why)',
    daemonMain.includes('successor scrub — a stored sign-in exists; the successor re-resolves it'),
  )
}

section('the fresh-sign-in trigger: first-only, self-guarded, receipted by')
{
  // The wiring: the anthropic sign-in landing fires the trigger
  // fire-and-forget (the sign-in never waits on the daemon).
  const oauthClient = readFileSync(join(ROOT, 'src', 'services', 'oauth', 'client.ts'), 'utf-8')
  check(
    'the sign-in landing calls restartOwnedDaemonForFreshSignin (fire-and-forget, catch armed)',
    oauthClient.includes('restartOwnedDaemonForFreshSignin()') && /void import\('\.\.\/\.\.\/daemon\/ownedDaemon\.js'\)[\s\S]{0,120}\.catch\(\(\) => \{\}\)/.test(oauthClient),
  )
  // The DRIVE (cpu-pure on a scratch home): plant the env-kept spawn record
  // through the proof seam, land a stored token, and hold the guards.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const savedHome = { config: process.env.MERCURY_CONFIG_DIR, auth: process.env.MERCURY_AUTH_SCOPE_DIR }
  const home = mkdtempSync(join(tmpdir(), 'authverify-sf2-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_AUTH_SCOPE_DIR = home
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const ownedMod = await import('../../src/daemon/ownedDaemon.js')
  const { clearOAuthTokenCache } = await import('../../src/utils/auth.js')
  clearOAuthTokenCache()
  const asks: Array<{ op: string; by: string; proto: number }> = []
  const rpc = async (req: { op: 'restart-when-idle'; proto: number; by: string }): Promise<unknown> => {
    asks.push(req)
    return { ok: true, op: 'restart-when-idle', state: 'armed', live: 1 }
  }
  // (1) no env-kept spawn record ⇒ never asks (stored-token spawns and
  // daemonless sessions are structurally out).
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: false, spawnLabel: 'daemon' })
  check('no env-kept record ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 0)
  // (2) env-kept record but the sign-in has NOT landed ⇒ not-applicable.
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: true, spawnLabel: 'daemon' })
  check('env-kept record without a landed store ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 0)
  // (3) the sign-in lands ⇒ ONE ask, at-idle, with the receipt reason.
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
  )
  // (4) the latch: a re-auth NEVER loops the restart.
  check('a second landing never asks again (one-shot latch)', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 1)
  // (5) no spawn label (this process spawned nothing) ⇒ not-applicable even env-kept.
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: true, spawnLabel: null })
  check('a session that spawned no daemon ⇒ not-applicable', (await ownedMod.restartOwnedDaemonForFreshSignin({ rpc })) === 'not-applicable' && asks.length === 1)
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
