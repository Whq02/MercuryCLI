#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-signed-out-runner-adopts-credential.ts — a process
//  that booted signed out adopts a credential ANOTHER process stores later
//  (FN-019 blocker 1: the "sign in later" first session).
//
//  The chat's engine is not the screen: the prompt rides onto a long-lived
//  runner child whose credential reads are process-lifetime memos (the
//  stored claude.ai sign-in, the /logins managed key). The runner's only
//  cross-process invalidator stats the credential file and treated
//  absent-to-present as no change: a runner spawned before the first
//  sign-in memoized null, the file then appeared with an mtime the process
//  had never seen, and the `!== null` guard read that as nothing to clear —
//  every message of the chat answered "Authentication failed" after a
//  sign-in that changed nothing. The managed-key memo had no cross-process
//  invalidator at all.
//
//   §1 a scratch home boots signed out: every reader answers none
//   §2 the managed key lands from ANOTHER process (the /logins writer's
//      config estate) — the next request-path read adopts it
//   §3 the claude.ai sign-in lands from ANOTHER process (the login's
//      secure-storage door, file-backed) — the next read adopts it
//   §4 the shape: the invalidator names both transitions
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-signed-out-runner-adopts-credential.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'signed-out-runner-'))
const HOME = join(SCRATCH, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
mkdirSync(HOME, { recursive: true })
delete process.env.MERCURY_HOME
// The file-backed credential store — a scratch home must never reach the
// machine's OS keychain (the secureStorage pin).
process.env.MERCURY_CREDENTIAL_STORE = 'file'
// No env credential may shadow the two stores under proof.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
delete process.env.MERCURY_API_KEY_FILE_DESCRIPTOR
// The key ladder's CI/test refusal keys on these — absent, the ladder
// resolves normally. NODE_ENV must stay UNSET under bun (the jsxDEV class).
delete process.env.CI
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const KEY = 'sk-ant-api03-signed-out-runner-proof'
const TOKEN = 'at_signed_out_runner_proof'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// The OTHER process: the writer a sign-in runs in the screen. It lands the
// credential through the product's own doors (the durable config writer,
// the secure-storage update) against the same scratch home.
const WRITER = join(SCRATCH, 'writer.ts')
writeFileSync(
  WRITER,
  `process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.CI
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs, saveGlobalConfig, getGlobalConfig } = await import(${JSON.stringify(join(ROOT, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
if (process.argv[2] === 'key') {
  // What /logins writes off the keychain: the managed key in the config estate.
  saveGlobalConfig(c => ({ ...c, primaryApiKey: ${JSON.stringify(KEY)} }))
  console.log('WROTE ' + (getGlobalConfig().primaryApiKey === ${JSON.stringify(KEY)}))
} else {
  const auth = await import(${JSON.stringify(join(ROOT, 'src/utils/auth.ts'))})
  const r = auth.saveOAuthTokensIfNeeded({
    accessToken: ${JSON.stringify(TOKEN)},
    refreshToken: 'rt_signed_out_runner_proof',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: null,
  })
  console.log('WROTE ' + r.success)
}
`,
)
const runWriter = (mode: 'key' | 'oauth'): boolean => {
  const r = spawnSync(process.execPath, ['run', WRITER, mode], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env },
    timeout: 60_000,
  })
  const ok = r.status === 0 && /WROTE true/.test(r.stdout)
  if (!ok) console.log(`    writer(${mode}) rc=${r.status}\n${r.stdout}\n${r.stderr}`.trim())
  return ok
}

// Config reads are boot-gated; the prover is its own boot (the runner's).
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')

console.log('============================================================')
console.log(' a signed-out process adopts the credential stored after it booted')
console.log('============================================================')

// ── §1 ───────────────────────────────────────────────────────────────────────
section('§1 a scratch home boots signed out')
{
  // The client's auth step, as every request runs it.
  check('the refresh check on an empty home is a no-op', (await auth.checkAndRefreshOAuthTokenIfNeeded()) === false)
  check('no stored claude.ai sign-in', auth.getClaudeAIOAuthTokens() === null)
  check("the token source is 'none'", auth.getAuthTokenSource().source === 'none', auth.getAuthTokenSource().source)
  const ladder = auth.getAnthropicApiKeyWithSource()
  check("the key ladder answers 'none'", ladder.source === 'none' && ladder.key === null, `${ladder.source}`)
  check('not a subscriber', auth.isClaudeAISubscriber() === false)
}

// ── §2 ───────────────────────────────────────────────────────────────────────
section('§2 the managed key lands from another process — the next read adopts it')
{
  check('the /logins writer landed the key', runWriter('key'))
  // The runner's next request: the client's auth step, then the ladder. The
  // config estate's freshness watcher polls at one second; the window is
  // generous so a loaded box never fakes the red.
  let adopted: { key: string | null; source: string } | null = null
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    await auth.checkAndRefreshOAuthTokenIfNeeded()
    const r = auth.getAnthropicApiKeyWithSource()
    if (r.key === KEY) {
      adopted = r
      break
    }
    await sleep(200)
  }
  check('THE NEXT READ ADOPTS THE MANAGED KEY (the base held boot\'s null for the process\'s whole life)', adopted !== null, 'still no key after 8s')
  check("…under the '/logins managed key' source", adopted?.source === '/logins managed key', String(adopted?.source))
  check('a credential is present now', auth.hasFirstPartyCredential() === true)
}

// ── §3 ───────────────────────────────────────────────────────────────────────
section('§3 the claude.ai sign-in lands from another process — the next read adopts it')
{
  check('the login writer landed the sign-in', runWriter('oauth'))
  check('the credential file now exists (absent → present)', existsSync(join(HOME, '.credentials.json')))
  // The runner's next request.
  await auth.checkAndRefreshOAuthTokenIfNeeded()
  const tokens = auth.getClaudeAIOAuthTokens()
  check('THE NEXT READ ADOPTS THE STORED SIGN-IN (the base never cleared on absent → present)', tokens?.accessToken === TOKEN, JSON.stringify(tokens))
  check("the token source is 'claude.ai'", auth.getAuthTokenSource().source === 'claude.ai', auth.getAuthTokenSource().source)
  check('the session is a subscriber now', auth.isClaudeAISubscriber() === true)
  check('the sign-in is not read as expired', auth.isAnthropicOAuthSignInExpired() === false)
}

// ── §4 ───────────────────────────────────────────────────────────────────────
section('§4 the shape: the invalidator names both transitions')
{
  const src = readFileSync(join(ROOT, 'src/utils/auth.ts'), 'utf8')
  const start = src.indexOf('function invalidateOnDiskChange')
  const inv = src.slice(start, src.indexOf('// --- Refresh', start))
  check('the invalidator exists', start > 0)
  check('absent → present is a change (a null last-mtime clears)', /lastCredentialsMtimeMs === null \|\|/.test(inv))
  check('the absent branch remembers the absence', /lastCredentialsMtimeMs = null/.test(inv))
  check('the managed-key memo has a cross-process invalidator', /getApiKeyFromConfigOrMacOSKeychain\.cache\?\.clear/.test(inv))
  check('…and the boot prefetch goes with it (a stale prefetch would answer the cleared memo)', /clearLegacyApiKeyPrefetch\(\)/.test(inv))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-signed-out-runner-adopts-credential${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
