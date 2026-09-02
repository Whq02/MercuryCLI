#!/usr/bin/env bun
// ============================================================================
//  prove-refresh-save-truth — a token refresh that landed on the wire but
//  not on disk keeps the session alive on the fresh pair and says so
//  (release-hardening audit rank 47).
//
//  The lie: doRefresh spent the stored refresh token against the token
//  endpoint, handed the new pair to saveOAuthTokensIfNeeded, discarded its
//  {success, warning} verdict and answered true. When the store refused the
//  write (ENOSPC, a handle refusal, an auth home whose parent is missing —
//  on win32 the single writeFileSync leg) the new pair was gone: the turn
//  went out on the stale access token, the API answered 401, the 401 handler
//  forced another refresh presenting the SPENT refresh token, invalid_grant
//  came back, the token was recorded dead and blanked on disk, and the
//  session dropped to the sign-in wall. Nothing named the failed write.
//
//  The law, driven through the REAL refresh road (the token endpoint is a
//  scripted axios adapter; the store is the file store in a scratch home):
//    §1 a refused save holds the fresh pair for this process: every token
//       reader answers it, the failure is queryable with its errno, the disk
//       keeps the old record, and no sign-in wall is armed;
//    §2 a 401 on the old access token answers "already refreshed" without
//       a second wire spend;
//    §3 the next refresh presents the HELD refresh token, and once the store
//       accepts the write the pair is released and the disk is the truth;
//    §4 a store that moves under a held pair (a new sign-in) wins — the pair
//       is dropped, the failure clears;
//    §5 control: a writable store saves the pair and holds nothing.
//
//  PROVE_SRC names another checkout's src (the A/B control: §1-§4 read red
//  at the pre-fix tree — the verdict discarded, the pair lost).
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'refresh-save-truth-'))
const HOME = join(SCRATCH, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
mkdirSync(HOME, { recursive: true })
delete process.env.MERCURY_HOME
// The file-backed credential store — a scratch home must never reach the
// machine's OS keychain.
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
// The key ladder's CI/test refusal keys on these; NODE_ENV stays unset under
// bun (the jsxDEV desync class).
delete process.env.CI
delete process.env.NODE_ENV
delete process.env.MERCURY_CUSTOM_OAUTH_URL
// The MACRO stamp MUST precede any src import that reads it: the token
// legs present the product's User-Agent, which reads the version stamp —
// without it the refresh threw before the wire and answered false.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The wire: the axios instance the product under proof resolves (the tree's
// own node_modules, by real path) gets its default adapter replaced BEFORE
// the product modules load. The token endpoint answers a scripted pair;
// every other wire (the profile fetch) fails like a network with no route.
const axiosEntry = realpathSync(join(SRC, '..', 'node_modules', 'axios', 'index.js'))
const axios = ((await import(axiosEntry)) as { default: { defaults: { adapter: unknown } } }).default
const wire: Array<{ refreshToken: string | undefined }> = []
let issue = { access: 'at_new', refresh: 'rt_new' }
axios.defaults.adapter = async (config: { url?: string; data?: unknown }) => {
  const url = String(config.url ?? '')
  if (url.endsWith('/oauth/token')) {
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : (config.data ?? {})) as { refresh_token?: string }
    wire.push({ refreshToken: body.refresh_token })
    return {
      data: { access_token: issue.access, refresh_token: issue.refresh, expires_in: 3600, scope: 'user:inference', token_type: 'Bearer' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const error = new Error(`no route to ${url}`) as Error & { code?: string }
  error.code = 'ENETUNREACH'
  throw error
}

// Config reads are boot-gated; the prover is its own boot.
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const auth = await import(join(SRC, 'utils/auth.ts'))
const { getSecureStorage } = await import(join(SRC, 'utils/secureStorage/index.ts'))

const CREDENTIALS = join(HOME, '.credentials.json')
const diskRefreshToken = (): string | undefined =>
  (JSON.parse(readFileSync(CREDENTIALS, 'utf8')) as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken
const held = (): { warning: string; at: number } | null =>
  (auth.getOAuthRefreshSaveFailure as (() => { warning: string; at: number } | null) | undefined)?.() ?? null
const accessNow = (): string | undefined => (auth.getClaudeAIOAuthTokens() as { accessToken?: string } | null)?.accessToken
const writable = (): void => chmodSync(HOME, 0o700)
const readOnly = (): void => chmodSync(HOME, 0o500)

/** An EXPIRED claude.ai sign-in on disk, the way the login lands it. */
function seed(access: string, refresh: string): boolean {
  writable()
  const result = getSecureStorage().update({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() - 60_000,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    },
  }) as { success: boolean }
  auth.clearOAuthTokenCache()
  ;(auth.__resetUnsavedRefreshForTest as (() => void) | undefined)?.()
  auth.__resetKnownDeadRefreshTokensForTest()
  return result.success
}

section('§1 A REFUSED SAVE HOLDS THE FRESH PAIR')
{
  check('the expired sign-in is seeded', seed('at_old', 'rt_old'))
  check('precondition: the store refuses a write while the home is read-only', (() => {
    readOnly()
    const probe = getSecureStorage().update({ claudeAiOauth: { accessToken: 'probe', refreshToken: 'probe', expiresAt: 1, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } }) as { success: boolean }
    return probe.success === false && diskRefreshToken() === 'rt_old'
  })())
  auth.clearOAuthTokenCache()
  issue = { access: 'at_new', refresh: 'rt_new' }
  // The wire probe: the token leg driven bare, so a throw before the
  // adapter is printed rather than swallowed by the refresh road's catch.
  {
    const oauth = await import(join(SRC, 'services/oauth/client.ts'))
    try {
      const probed = (await oauth.refreshOAuthToken('rt_probe', {})) as { accessToken?: string }
      console.log(`  probe: the token leg answers ${String(probed.accessToken)} (wire hits so far: ${wire.length})`)
    } catch (error) {
      console.log(`  probe: the token leg THREW before or at the wire — ${error instanceof Error ? error.message : String(error)}`)
    }
    wire.length = 0
  }
  const refreshed = await auth.checkAndRefreshOAuthTokenIfNeeded()
  check('the refresh answers true — a usable fresh token is in hand', refreshed === true)
  check('the wire was spent once, with the stored refresh token', wire.length === 1 && wire[0]?.refreshToken === 'rt_old', JSON.stringify(wire))
  check('every token reader answers the FRESH pair', accessNow() === 'at_new', String(accessNow()))
  check('the async reader agrees', ((await auth.getClaudeAIOAuthTokensAsync()) as { accessToken?: string } | null)?.accessToken === 'at_new')
  check('the disk still holds the record the pair superseded', diskRefreshToken() === 'rt_old', String(diskRefreshToken()))
  const failure = held()
  check('the storage failure is queryable and names the errno', failure !== null && /could not be saved/.test(failure.warning) && /EACCES|EPERM/.test(failure.warning), failure?.warning)
  check('no sign-in wall is armed', auth.isAnthropicOAuthSignInExpired() === false && auth.isOAuthRefreshKnownDead() === false)
}

section('§2 A 401 ON THE OLD TOKEN BURNS NOTHING')
{
  const recovered = await auth.handleOAuth401Error('at_old')
  check('the 401 handler answers "already refreshed"', recovered === true)
  check('no second wire spend — the spent refresh token is never presented again', wire.length === 1, String(wire.length))
  check('the fresh token still answers', accessNow() === 'at_new')
}

section('§3 THE NEXT REFRESH PRESENTS THE HELD TOKEN AND THE SAVE LANDS')
{
  writable()
  issue = { access: 'at_new2', refresh: 'rt_new2' }
  const again = await auth.checkAndRefreshOAuthTokenIfNeeded(0, true)
  check('the forced refresh answers true', again === true)
  check('the wire was presented the HELD refresh token, never the spent one', wire.length === 2 && wire[1]?.refreshToken === 'rt_new', JSON.stringify(wire))
  check('the landed save is the truth: the disk holds the newest pair', diskRefreshToken() === 'rt_new2', String(diskRefreshToken()))
  check('the pair is released — no failure held', held() === null, JSON.stringify(held()))
  check('the readers answer the saved pair', accessNow() === 'at_new2', String(accessNow()))
}

section('§4 A STORE THAT MOVES UNDER A HELD PAIR WINS')
{
  wire.length = 0
  check('a second expired sign-in is seeded', seed('at_a', 'rt_a'))
  readOnly()
  auth.clearOAuthTokenCache()
  issue = { access: 'at_b', refresh: 'rt_b' }
  check('the refresh holds the pair (refused save)', (await auth.checkAndRefreshOAuthTokenIfNeeded()) === true && held() !== null && accessNow() === 'at_b')
  writable()
  // A new sign-in lands on disk (the login door's write), unrelated to the pair.
  const landed = getSecureStorage().update({
    claudeAiOauth: { accessToken: 'at_login', refreshToken: 'rt_login', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null },
  }) as { success: boolean }
  auth.clearOAuthTokenCache()
  check('the new sign-in landed', landed.success)
  check('the readers answer the disk again — the pair is dropped', accessNow() === 'at_login', String(accessNow()))
  check('the failure clears with the pair', held() === null)
}

section('§5 CONTROL: A WRITABLE STORE SAVES THE PAIR AND HOLDS NOTHING')
{
  wire.length = 0
  check('a third expired sign-in is seeded', seed('at_c', 'rt_c'))
  issue = { access: 'at_d', refresh: 'rt_d' }
  check('the refresh answers true', (await auth.checkAndRefreshOAuthTokenIfNeeded()) === true)
  check('the disk holds the new pair', diskRefreshToken() === 'rt_d', String(diskRefreshToken()))
  check('nothing is held', held() === null)
  check('the readers answer the saved pair', accessNow() === 'at_d')
}

writable()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-refresh-save-truth: ALL PASS' : `\nprove-refresh-save-truth: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
