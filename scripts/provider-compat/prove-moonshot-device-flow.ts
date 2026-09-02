#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-moonshot-device-flow.ts — the Moonshot/Kimi
//  account owner as a PURE client: the RFC-8628 device flow, the refresh
//  honesty, the region store and the env > sign-in > stored-key ladder,
//  entirely against an injected fetch (no network — the wire shapes are the
//  ones Moonshot's own open-source client speaks, MoonshotAI/kimi-code
//  packages/oauth/src/{constants,region,oauth}.ts, read 2026-08-23).
//
//    1. The verified constants: the published public client id, the two
//       regions' OAuth hosts and coding bases; the env seams override them
//       for BOTH regions (fixtures), never a refusal.
//    2. The device ladder in a region: start hits that region's host with
//       the published client id; pending → slow-down → authorized; tokens
//       persist auth-scoped (mode 600) WITH the region; values never in
//       labels.
//    3. Refresh: success rotates (refresh token retained when omitted); a
//       transport failure KEEPS the tokens; a 400/401 refusal DROPS them.
//    4. The ladder + the dispatch credential: a sign-in dispatches on its
//       region's coding base with the bearer; a key rides the platform
//       base; env > sign-in > stored; a disconnect keeps the region; an
//       expiring sign-in refreshes under the margin, an expired one with no
//       refresh route is dropped.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-moonshot-device-flow.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'moonshot-oauth-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MOONSHOT_API_KEY
delete process.env.MERCURY_MOONSHOT_OAUTH_BASE
delete process.env.MERCURY_MOONSHOT_OAUTH_CLIENT_ID
delete process.env.MERCURY_MOONSHOT_CODING_BASE
delete process.env.MERCURY_MOONSHOT_API_BASE

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const {
  KIMI_OAUTH_CLIENT_ID,
  kimiCodingBase,
  kimiCodingChatCompletionsUrl,
  kimiUsagesUrl,
  moonshotAuthPathForDisplay,
  moonshotChatCompletionsUrl,
  moonshotDispatchSource,
  moonshotLoginRegion,
  moonshotOauthBase,
  moonshotOauthClientId,
  moonshotStoredRegion,
  moonshotStoredTokens,
  pollMoonshotDeviceToken,
  refreshMoonshotTokens,
  resolveMoonshotAccount,
  resolveMoonshotDispatchCredential,
  startMoonshotDeviceAuth,
  writeMoonshotRegion,
  writeMoonshotTokens,
  disconnectMoonshotOauth,
} = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const { writeStoredMoonshotApiKey } = await import('../../src/utils/router/providerSecrets.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

section('1 · the verified constants and the proof seams')
{
  check('the published public client id is the constant', KIMI_OAUTH_CLIENT_ID === '17e5f671-d194-4dfb-9706-5516cb48c098')
  check('unpinned ⇒ the client id is the constant', moonshotOauthClientId({} as NodeJS.ProcessEnv) === KIMI_OAUTH_CLIENT_ID)
  check('the global region: auth.kimi.ai + api.kimi.ai/coding/v1', moonshotOauthBase('global', {} as NodeJS.ProcessEnv) === 'https://auth.kimi.ai' && kimiCodingBase('global', {} as NodeJS.ProcessEnv) === 'https://api.kimi.ai/coding/v1')
  check('the mainland region: auth.kimi.com + api.kimi.com/coding/v1', moonshotOauthBase('mainland-cn', {} as NodeJS.ProcessEnv) === 'https://auth.kimi.com' && kimiCodingBase('mainland-cn', {} as NodeJS.ProcessEnv) === 'https://api.kimi.com/coding/v1')
  const pinned = {
    MERCURY_MOONSHOT_OAUTH_BASE: 'https://oauth.fixture.example/',
    MERCURY_MOONSHOT_CODING_BASE: 'https://coding.fixture.example/v1/',
    MERCURY_MOONSHOT_OAUTH_CLIENT_ID: 'client-override',
  } as NodeJS.ProcessEnv
  check('the OAuth seam pins BOTH regions to the fixture host (trailing slash trimmed)', moonshotOauthBase('global', pinned) === 'https://oauth.fixture.example' && moonshotOauthBase('mainland-cn', pinned) === 'https://oauth.fixture.example')
  check('the coding seam pins BOTH regions; usages + chat ride it', kimiUsagesUrl('mainland-cn', pinned) === 'https://coding.fixture.example/v1/usages' && kimiCodingChatCompletionsUrl('global', pinned) === 'https://coding.fixture.example/v1/chat/completions')
  check('an operator-issued client id overrides the constant', moonshotOauthClientId(pinned) === 'client-override')
  check('the platform base is untouched by the sign-in seams', moonshotChatCompletionsUrl(pinned) === 'https://api.moonshot.ai/v1/chat/completions')
}

section('2 · the device-flow ladder in a region (injected fetch — no network)')
{
  const seen: { url: string; body: string }[] = []
  const ladder = [
    jsonResponse(400, { error: 'authorization_pending' }),
    jsonResponse(400, { error: 'slow_down' }),
    jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' }),
  ]
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    seen.push({ url: u, body: String(init?.body ?? '') })
    if (u.endsWith('/api/oauth/device_authorization')) {
      return jsonResponse(200, {
        device_code: 'dev-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.kimi.com/activate',
        verification_uri_complete: 'https://auth.kimi.com/activate?code=ABCD-EFGH',
        interval: 1,
        expires_in: 300,
      })
    }
    if (u.endsWith('/api/oauth/token')) return ladder.shift() ?? jsonResponse(400, { error: 'expired_token' })
    return jsonResponse(404, {})
  }) as typeof fetch
  const start = await startMoonshotDeviceAuth({ fetchImpl, region: 'mainland-cn', now: () => 1_000 })
  check('start hits the MAINLAND host with the documented path', seen[0]?.url === 'https://auth.kimi.com/api/oauth/device_authorization', seen[0]?.url)
  check('the published client id rides the form body', seen[0]?.body === `client_id=${KIMI_OAUTH_CLIENT_ID}`, seen[0]?.body)
  check(
    'start decodes the RFC fields and carries the region',
    start.deviceCode === 'dev-123' && start.userCode === 'ABCD-EFGH' && start.verificationUriComplete === 'https://auth.kimi.com/activate?code=ABCD-EFGH' && start.intervalSec === 1 && start.expiresAtMs === 301_000 && start.region === 'mainland-cn',
  )
  const p1 = await pollMoonshotDeviceToken(start, { fetchImpl })
  const p2 = await pollMoonshotDeviceToken(start, { fetchImpl })
  const p3 = await pollMoonshotDeviceToken(start, { fetchImpl, now: () => 5_000 })
  check('pending → slow-down → authorized', p1.state === 'pending' && p2.state === 'slow-down' && p3.state === 'authorized')
  const tokenBody = seen.find(s => s.url.endsWith('/api/oauth/token'))?.body ?? ''
  check(
    'the poll speaks the device_code grant on the same region host',
    seen.find(s => s.url.endsWith('/api/oauth/token'))?.url === 'https://auth.kimi.com/api/oauth/token' &&
      tokenBody.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code') &&
      tokenBody.includes('device_code=dev-123') &&
      tokenBody.includes(`client_id=${KIMI_OAUTH_CLIENT_ID}`),
    tokenBody,
  )
  if (p3.state === 'authorized') {
    writeMoonshotTokens(p3.tokens, start.region)
    check('tokens persist with expiry', moonshotStoredTokens()?.accessToken === 'at-1' && moonshotStoredTokens()?.accessTokenExpiresAtMs === 3_605_000)
  }
  check('the region persists with the login', moonshotStoredRegion() === 'mainland-cn' && moonshotLoginRegion() === 'mainland-cn')
  const mode = statSync(moonshotAuthPathForDisplay()).mode & 0o777
  check('the auth file is mode 600', mode === 0o600, mode.toString(8))
  const account = resolveMoonshotAccount({} as NodeJS.ProcessEnv)
  check('the account is the Kimi sign-in, named by region, never the token', account?.kind === 'kimi-oauth' && account.region === 'mainland-cn' && account.label.includes('mainland China') && !account.label.includes('at-1'))
  const down = (async () => {
    throw new TypeError('fetch failed: ECONNREFUSED')
  }) as typeof fetch
  const unreachable = await pollMoonshotDeviceToken(start, { fetchImpl: down })
  check('a transport fault polls as the typed unreachable (never a throw)', unreachable.state === 'unreachable')
  const denied = await pollMoonshotDeviceToken(start, { fetchImpl: (async () => jsonResponse(400, { error: 'access_denied', error_description: 'user declined' })) as typeof fetch })
  check('a denial is typed with the description', denied.state === 'denied' && denied.code === 'access_denied' && denied.description === 'user declined')
}

section('3 · refresh honesty')
{
  const rotated = (async (url: unknown, init?: RequestInit) => {
    check('refresh hits the token path on the login region host', String(url) === 'https://auth.kimi.com/api/oauth/token')
    check('refresh grant rides with the client id', String(init?.body ?? '').includes('grant_type=refresh_token') && String(init?.body ?? '').includes(`client_id=${KIMI_OAUTH_CLIENT_ID}`))
    return jsonResponse(200, { access_token: 'at-2', expires_in: 3600 })
  }) as typeof fetch
  const fresh = await refreshMoonshotTokens({ fetchImpl: rotated })
  check('refresh rotates the access token', fresh?.accessToken === 'at-2')
  check('server-omitted refresh token retained', moonshotStoredTokens()?.refreshToken === 'rt-1')
  const failing = (async () => {
    throw new Error('ECONNRESET')
  }) as typeof fetch
  const kept = await refreshMoonshotTokens({ fetchImpl: failing })
  check('a transport failure KEEPS the stored tokens', kept === undefined && moonshotStoredTokens()?.accessToken === 'at-2')
  const refused = (async () => jsonResponse(401, { error: 'invalid_grant' })) as typeof fetch
  const dead = await refreshMoonshotTokens({ fetchImpl: refused })
  check('a refused refresh drops stored tokens (no zombie identity)', dead === undefined && moonshotStoredTokens() === undefined)
  check('…but the region stays remembered', moonshotStoredRegion() === 'mainland-cn')
}

section('4 · the ladder + the dispatch credential (env > sign-in > stored key)')
{
  const env = {} as NodeJS.ProcessEnv
  check('no credential ⇒ no account, no dispatch', resolveMoonshotAccount(env) === undefined && (await resolveMoonshotDispatchCredential({ env })) === undefined && moonshotDispatchSource(env) === undefined)
  writeMoonshotTokens({ accessToken: 'at-3', refreshToken: 'rt-3' }, 'global')
  const signedIn = await resolveMoonshotDispatchCredential({ env })
  check(
    'a sign-in dispatches on ITS region coding base with the bearer',
    signedIn?.source === 'kimi-oauth' && signedIn.apiKey === 'at-3' && signedIn.requestUrl === 'https://api.kimi.ai/coding/v1/chat/completions',
    JSON.stringify(signedIn),
  )
  writeStoredMoonshotApiKey('sk-moon-stored-77777')
  check('the sign-in outranks the stored key (display and dispatch agree)', resolveMoonshotAccount(env)?.kind === 'kimi-oauth' && (await resolveMoonshotDispatchCredential({ env }))?.source === 'kimi-oauth')
  const keyedEnv = { MOONSHOT_API_KEY: 'sk-moon-env-88888' } as NodeJS.ProcessEnv
  const envDispatch = await resolveMoonshotDispatchCredential({ env: keyedEnv })
  check(
    'the env key outranks everything and rides the platform base',
    resolveMoonshotAccount(keyedEnv)?.kind === 'api-key' && envDispatch?.source === 'env' && envDispatch.apiKey === 'sk-moon-env-88888' && envDispatch.requestUrl === 'https://api.moonshot.ai/v1/chat/completions',
  )
  const labels = JSON.stringify([resolveMoonshotAccount(env), resolveMoonshotAccount(keyedEnv)])
  check('labels never carry a token/key value', !labels.includes('at-3') && !labels.includes('sk-moon'))
  disconnectMoonshotOauth()
  check('a disconnect drops the tokens, keeps the region, falls to the stored key on the platform base', moonshotStoredTokens() === undefined && moonshotStoredRegion() === 'global' && (await resolveMoonshotDispatchCredential({ env }))?.source === 'stored' && (await resolveMoonshotDispatchCredential({ env }))?.requestUrl === 'https://api.moonshot.ai/v1/chat/completions')
  // Under the margin the dispatch resolver refreshes; expired with no
  // refresh route is dropped (the next source answers honestly).
  writeMoonshotTokens({ accessToken: 'at-4', refreshToken: 'rt-4', accessTokenExpiresAtMs: 1_000_000 }, 'global')
  let refreshed = 0
  const rotating = (async () => {
    refreshed++
    return jsonResponse(200, { access_token: 'at-5', expires_in: 3600 })
  }) as typeof fetch
  const untouched = await resolveMoonshotDispatchCredential({ fetchImpl: rotating, env, now: () => 0 })
  check('outside the margin the bearer is used as-is', refreshed === 0 && untouched?.apiKey === 'at-4')
  const refreshedCredential = await resolveMoonshotDispatchCredential({ fetchImpl: rotating, env, now: () => 1_000_000 - 5 * 60 * 1000 })
  check('inside the fifteen-minute margin the resolver refreshes first', refreshed === 1 && refreshedCredential?.apiKey === 'at-5' && refreshedCredential.requestUrl === 'https://api.kimi.ai/coding/v1/chat/completions')
  writeMoonshotTokens({ accessToken: 'at-6', accessTokenExpiresAtMs: 1_000 }, 'global')
  const expired = await resolveMoonshotDispatchCredential({ env, now: () => 2_000 })
  check('an expired sign-in with no refresh route is dropped; the stored key answers', expired?.source === 'stored' && moonshotStoredTokens() === undefined)
  writeMoonshotRegion('mainland-cn')
  check('the region can be remembered on its own (the card writes it before the flow)', moonshotStoredRegion() === 'mainland-cn')
  // The SECOND region end to end at the resolver: a mainland sign-in
  // dispatches on api.kimi.com's coding base with its own bearer.
  writeMoonshotTokens({ accessToken: 'at-7', refreshToken: 'rt-7' }, 'mainland-cn')
  const mainland = await resolveMoonshotDispatchCredential({ env })
  check(
    'a MAINLAND sign-in dispatches on api.kimi.com/coding/v1 with its bearer',
    mainland?.source === 'kimi-oauth' && mainland.apiKey === 'at-7' && mainland.requestUrl === 'https://api.kimi.com/coding/v1/chat/completions',
    JSON.stringify(mainland),
  )
  writeMoonshotTokens(null)
  writeStoredMoonshotApiKey(null)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
