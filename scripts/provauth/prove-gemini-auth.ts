#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-gemini-auth.ts
//  PROOF: the Gemini credential estate
//  against fixture rigs (injected fetch; every base pinned to a
//  non-resolvable host — the fail-open law):
//    1. the key ladder: GOOGLE_API_KEY > GEMINI_API_KEY > stored (the
//       DOCUMENTED client-library precedence), request auth rides the
//       x-goog-api-key header;
//    2. the OAuth client gate: no client config ⇒ the connect REFUSES with
//       the honest instruction (never a fake flow); env client id wins over
//       the stored config;
//    3. the OAuth machine: authorize URL shape (loopback :1457, both
//       documented scopes, S256, state, access_type=offline), paste
//       completion, exchange body, refresh-token persistence (mode 600),
//       no-refresh-token ⇒ the honest re-consent rejection, state-mismatch
//       paste rejects. (Begins create the loopback listener
//       opportunistically; a busy :1457 degrades to the same paste path BY
//       DESIGN — live loopback-redirect completion is DEFERRED-LIVE.)
//    4. refresh: expired tokens refresh ONCE (grant_type=refresh_token),
//       fresh-disk adoption needs ZERO network, a failed refresh returns
//       the stored set;
//    5. preference: api-key preference outranks a connected OAuth;
//       disconnect drops tokens but KEEPS the client config.
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-gemini-auth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — Gemini key ladder + Google OAuth (fixture rig)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_GEMINI_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gemini-auth-'))
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'https://fixture.invalid/o/oauth2/v2/auth'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://fixture.invalid/token'

const accounts = await import('../../src/services/providers/gemini/geminiAccounts.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const {
  __resetGeminiAccountsForTest,
  beginGeminiBrowserConnect,
  currentGeminiTokens,
  disconnectGeminiOauth,
  geminiAuthPathForDisplay,
  geminiOauthClientConfig,
  geminiOauthClientMissingCopy,
  geminiOauthConnected,
  resolveGeminiAccount,
  resolveGeminiApiKey,
  resolveGeminiRequestAuth,
  writeGeminiOauthClientConfig,
  writePreferredGeminiSource,
} = accounts

// ── 1. the key ladder (documented precedence) + request auth header ─────────
{
  check('nothing anywhere ⇒ no account', resolveGeminiAccount() === undefined)
  secrets.writeStoredGeminiApiKey('AIza-STORED-000000000000000')
  check('stored key resolves last', resolveGeminiApiKey()?.source === 'stored')
  process.env.GEMINI_API_KEY = 'AIza-GEMINI-000000000000000'
  check('GEMINI_API_KEY outranks the store', resolveGeminiApiKey()?.source === 'env-gemini')
  process.env.GOOGLE_API_KEY = 'AIza-GOOGLE-000000000000000'
  check('GOOGLE_API_KEY outranks GEMINI_API_KEY (the documented precedence)', resolveGeminiApiKey()?.source === 'env-google')
  const auth = await resolveGeminiRequestAuth()
  check('key request auth: pinned base + x-goog-api-key header (no bearer)', auth?.baseUrl === 'https://fixture.invalid/v1beta' && auth?.headers['x-goog-api-key'] === 'AIza-GOOGLE-000000000000000' && auth?.headers.authorization === undefined)
  delete process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_API_KEY
  secrets.writeStoredGeminiApiKey(null)
}

// ── 2. the OAuth client gate ────────────────────────────────────────────────
{
  check('no client config ⇒ the honest gate copy', typeof geminiOauthClientMissingCopy() === 'string' && geminiOauthClientMissingCopy()!.includes('Desktop app'))
  const handles = beginGeminiBrowserConnect({ skipBrowserOpen: true })
  const outcome = await handles.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check('clientless connect REFUSES with the gate copy (no URL, no flow)', outcome !== 'resolved' && String(outcome).includes('OAuth client') && handles.authorizeUrl === '')

  writeGeminiOauthClientConfig({ clientId: 'stored-client-id.apps.googleusercontent.com', clientSecret: 'stored-secret' })
  check('stored client config resolves', geminiOauthClientConfig()?.clientId === 'stored-client-id.apps.googleusercontent.com' && geminiOauthClientConfig()?.source === 'stored')
  process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID = 'env-client-id.apps.googleusercontent.com'
  check('env client id wins over the stored config', geminiOauthClientConfig()?.clientId === 'env-client-id.apps.googleusercontent.com' && geminiOauthClientConfig()?.source === 'env')
  delete process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID
}

// ── 3. the OAuth machine: URL shape → paste → exchange → persistence ────────
{
  const seen: Array<{ url: string; body: URLSearchParams }> = []
  const tokenFetch: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
    return new Response(
      JSON.stringify({
        access_token: 'FIXTURE-ACCESS',
        refresh_token: 'FIXTURE-REFRESH',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const handles = beginGeminiBrowserConnect({ skipBrowserOpen: true, fetchImpl: tokenFetch })
  const url = new URL(handles.authorizeUrl)
  check('authorize URL rides the PINNED base', handles.authorizeUrl.startsWith('https://fixture.invalid/o/oauth2/v2/auth?'))
  check('client id + loopback :1457 redirect', url.searchParams.get('client_id') === 'stored-client-id.apps.googleusercontent.com' && (url.searchParams.get('redirect_uri') ?? '').includes('127.0.0.1:1457'))
  const scope = url.searchParams.get('scope') ?? ''
  check('both documented scopes stated', scope.includes('cloud-platform') && scope.includes('generative-language.retriever'))
  check('S256 + state + offline access', url.searchParams.get('code_challenge_method') === 'S256' && (url.searchParams.get('state') ?? '').length > 20 && url.searchParams.get('access_type') === 'offline')

  const state = url.searchParams.get('state')!
  handles.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=FIXTURE-CODE&state=${state}`)
  const ref = await handles.result
  check('connect resolves the oauth account ref', ref.kind === 'oauth' && ref.label === 'Google account (OAuth)')
  const exchange = seen[0]!
  check('exchange body: authorization_code grant + verifier + client pair', exchange.body.get('grant_type') === 'authorization_code' && exchange.body.get('code') === 'FIXTURE-CODE' && (exchange.body.get('code_verifier') ?? '').length >= 40 && exchange.body.get('client_secret') === 'stored-secret')
  check('tokens persisted; oauth connected', geminiOauthConnected())
  const mode = statSync(geminiAuthPathForDisplay()).mode & 0o777
  check('auth store mode 600', mode === 0o600, `mode ${mode.toString(8)}`)
  const oauthAuth = await resolveGeminiRequestAuth({ fetchImpl: tokenFetch })
  check('oauth request auth: bearer header on the pinned API base', oauthAuth?.headers.authorization === 'Bearer FIXTURE-ACCESS' && oauthAuth?.baseUrl === 'https://fixture.invalid/v1beta')
}

// ── 3b. state-mismatch paste rejects; no-refresh-token response rejects ─────
{
  disconnectGeminiOauth()
  const handles = beginGeminiBrowserConnect({ skipBrowserOpen: true })
  handles.completeWithRedirect('http://127.0.0.1:1457/oauth2/callback?code=X&state=WRONG')
  const outcome = await handles.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check('state-mismatch paste rejects honestly', String(outcome).includes('state does not match'))

  const noRefresh: typeof fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'A', expires_in: 3600 }), {
      status: 200,
    })) as unknown as typeof fetch
  const handles2 = beginGeminiBrowserConnect({ skipBrowserOpen: true, fetchImpl: noRefresh })
  const state2 = new URL(handles2.authorizeUrl).searchParams.get('state')!
  handles2.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=Y&state=${state2}`)
  const outcome2 = await handles2.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check('no refresh token ⇒ the honest re-consent rejection, nothing stored', String(outcome2).includes('no refresh token') && !geminiOauthConnected())
}

// ── 3c. Google's OWN refusal (error= on the redirect) settles with the
//        NAMED remedy — the testing-mode 403 access_denied above all
//        (operator live-drive block A: the browser tab alone was the only
//        answer while the terminal waited forever) ──────────────────────────
{
  const { geminiOauthErrorRemedy } = await import(
    '../../src/services/providers/gemini/geminiAccounts.ts'
  )
  const denied = geminiOauthErrorRemedy('access_denied', 'app is in testing mode')
  check('access_denied names the test-user remedy', denied.includes('Test users'))
  check('access_denied names the publish alternative', denied.includes('publish the app'))
  check('access_denied carries the description verbatim', denied.includes('app is in testing mode'))
  check('the remedy names the retry route', denied.includes('/logins'))
  check('org_internal names the workspace restriction', geminiOauthErrorRemedy('org_internal').includes('organization'))
  check('an unknown code stays verbatim + routed', geminiOauthErrorRemedy('temporarily_unavailable').includes('temporarily_unavailable'))

  const handles = beginGeminiBrowserConnect({ skipBrowserOpen: true })
  handles.completeWithRedirect(
    'http://127.0.0.1:1457/oauth2/callback?error=access_denied&error_description=access_denied+by+policy',
  )
  const outcome = await handles.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check(
    'a pasted error redirect settles the terminal with the remedy (never hangs)',
    String(outcome).includes('Test users') && String(outcome).includes('publish the app'),
    String(outcome),
  )
  check('nothing stored on a refusal', !geminiOauthConnected())
}

// ── 4. refresh discipline ───────────────────────────────────────────────────
{
  __resetGeminiAccountsForTest()
  // Seed an EXPIRED token set directly through the connect machinery's store
  // (write via a successful fixture connect, then age it by rewriting).
  const mint: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ access_token: 'OLD', refresh_token: 'RT-1', expires_in: -100 }),
      { status: 200 },
    )) as unknown as typeof fetch
  const handles = beginGeminiBrowserConnect({ skipBrowserOpen: true, fetchImpl: mint })
  const state = new URL(handles.authorizeUrl).searchParams.get('state')!
  handles.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=Z&state=${state}`)
  await handles.result
  check('seeded an expired grant', geminiOauthConnected())

  const counter = { posts: 0 }
  const refreshFetch: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    counter.posts++
    const body = new URLSearchParams(String(init?.body ?? ''))
    check('refresh grant rides the refresh token', body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'RT-1')
    return new Response(
      JSON.stringify({ access_token: 'NEW', expires_in: 3600 }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  const tokens = await currentGeminiTokens({ fetchImpl: refreshFetch })
  check('expired set refreshed ONCE; refresh token retained (no rotation)', counter.posts === 1 && tokens?.accessToken === 'NEW' && tokens?.refreshToken === 'RT-1')

  __resetGeminiAccountsForTest()
  const throwingFetch: typeof fetch = (async () => {
    throw new Error('prover: network must not be touched on this leg')
  }) as unknown as typeof fetch
  const fresh = await currentGeminiTokens({ fetchImpl: throwingFetch })
  check('fresh disk tokens adopted with ZERO network', fresh?.accessToken === 'NEW')

  __resetGeminiAccountsForTest()
  // Age the access token again via a direct file rewrite (unknown keys kept).
  const path = geminiAuthPathForDisplay()
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const t = file.tokens as Record<string, unknown>
  t.accessTokenExpiresAtMs = Date.now() - 1000
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
  const failingRefresh: typeof fetch = (async () => {
    throw new Error('prover: simulated refresh failure')
  }) as unknown as typeof fetch
  const stale = await currentGeminiTokens({ fetchImpl: failingRefresh })
  check('failed refresh returns the stored set (typed 401 downstream, never a throw)', stale?.refreshToken === 'RT-1')

  // Terminal revocation: a 400 invalid_grant from the token endpoint means
  // the refresh token is dead — the stored set DROPS (client config kept)
  // and every surface renders the honest signed-out state (/logins copy),
  // instead of re-attempting the doomed refresh forever.
  __resetGeminiAccountsForTest()
  const revokedRefresh: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  const revoked = await currentGeminiTokens({ fetchImpl: revokedRefresh })
  check('terminal invalid_grant ⇒ no tokens returned', revoked === undefined)
  check('terminal invalid_grant ⇒ stored tokens DROPPED (re-auth required)', !geminiOauthConnected())
  const fileAfterDrop = JSON.parse(readFileSync(geminiAuthPathForDisplay(), 'utf8')) as Record<string, unknown>
  check('the operator client config SURVIVES the drop (infrastructure, not a credential)', fileAfterDrop.clientConfig !== undefined || fileAfterDrop.client !== undefined, Object.keys(fileAfterDrop).join(','))

  // Re-seed a fresh connected set for the preference/disconnect leg below
  // (the drop above is this case's assertion, not the rig's end state).
  __resetGeminiAccountsForTest()
  fileAfterDrop.tokens = {
    accessToken: 'NEW',
    refreshToken: 'RT-1',
    accessTokenExpiresAtMs: Date.now() + 3_600_000,
  }
  writeFileSync(geminiAuthPathForDisplay(), JSON.stringify(fileAfterDrop, null, 2) + '\n', { mode: 0o600 })
}

// ── 5. preference + disconnect ──────────────────────────────────────────────
{
  process.env.GEMINI_API_KEY = 'AIza-GEMINI-000000000000000'
  check('oauth wins by default when both exist', resolveGeminiAccount()?.kind === 'oauth')
  writePreferredGeminiSource('api-key')
  check('api-key preference outranks the connected oauth', resolveGeminiAccount()?.kind === 'api-key')
  writePreferredGeminiSource(null)
  disconnectGeminiOauth()
  check('disconnect drops tokens, keeps the client config', !geminiOauthConnected() && geminiOauthClientConfig()?.clientId === 'stored-client-id.apps.googleusercontent.com')
  delete process.env.GEMINI_API_KEY
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} gemini-auth proof(s) failed`)
  process.exit(1)
}
console.log('✅ GEMINI KEY LADDER + GOOGLE OAUTH PROVEN (fixture rig; loopback bind + live generateContent-under-OAuth = DEFERRED-LIVE)')
