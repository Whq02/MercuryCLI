#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-huggingface-oauth.ts — the Hugging Face account
//  owner: the RFC 8628 device-code client with RFC 7591 self-registration,
//  refresh honesty, the credential ladder, identity, slots and usage —
//  entirely against an injected fetch replaying the shapes OBSERVED LIVE on
//  huggingface.co on 2026-08-22 (no network, no real client id):
//
//    POST /oauth/register (public client) → 201 {client_id, client_id_issued_at,
//      client_secret_expires_at: 0, grant_types[…], redirect_uris: [],
//      client_name, scope, token_endpoint_auth_method: 'none'}
//    POST /oauth/device → 200 {device_code, user_code 'NJAD-ATZC',
//      verification_uri 'https://hf.co/oauth/device', expires_in 300}
//      (no interval — the RFC default of 5s applies)
//    POST /oauth/token (pending) → 400 {error: 'authorization_pending',
//      error_description: 'Device code pending, not yet approved'}
//    POST /oauth/token (bogus) → 400 {error: 'invalid_grant',
//      error_description: 'Invalid device code'}
//  The token success shape follows the Hub's documented token response
//  ({access_token 'hf_oauth_…', token_type 'bearer', expires_in, scope};
//  refresh_token per the huggingface_hub client) — deferred-live to
//  confirm byte-for-byte.
//
//    1. Client id: the operator pin wins; else the stored registration
//       (per hub base); else a fresh registration is made ONCE and kept.
//    2. The device ladder: start decodes the observed fields (interval
//       defaults to 5); pending → slow-down → authorized; tokens persist
//       auth-scoped; identity rides from whoami; values never in labels.
//    3. Refresh: success rotates (refresh token retained when omitted);
//       a 400/401 refusal DROPS tokens; a transport failure keeps them.
//    4. The credential ladder: env HF_TOKEN > OAuth > stored paste; the
//       dispatch resolver refreshes under the margin.
//    5. Slots (/accounts), usability, usage shape (api-spend + the stated
//       absence), and routed removal.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-huggingface-oauth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'huggingface-oauth-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.HF_TOKEN
delete process.env.MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID
delete process.env.MERCURY_HUGGINGFACE_BILL_TO
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'https://hub.fixture.example'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://router.fixture.example/v1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const accounts = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
const {
  startHuggingfaceDeviceAuth,
  pollHuggingfaceDeviceToken,
  refreshHuggingfaceTokens,
  resolveHuggingfaceOauthClientId,
  huggingfaceRegisteredClientId,
  writeHuggingfaceTokens,
  huggingfaceStoredTokens,
  resolveHuggingfaceAccount,
  resolveHuggingfaceApiKey,
  resolveHuggingfaceDispatchCredential,
  fetchHuggingfaceIdentity,
  writeHuggingfaceTokenIdentity,
  huggingfaceAuthPathForDisplay,
  huggingfaceKeyTail,
  HF_OAUTH_SCOPE,
} = accounts
const { writeStoredHuggingfaceApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { HUGGINGFACE_USAGE_ABSENCE_NOTE } = await import('../../src/services/providers/huggingface/huggingfaceUsageState.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The observed shapes, replayed verbatim (ids/codes are the fixture's).
const REGISTER_201 = {
  client_id: '2fe1fbdb-ed49-4737-9676-035882bea588',
  client_id_issued_at: 1787368253,
  client_secret_expires_at: 0,
  grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'authorization_code', 'refresh_token'],
  redirect_uris: [],
  client_name: 'Mercury',
  scope: 'openid profile inference-api',
  token_endpoint_auth_method: 'none',
}
const DEVICE_200 = {
  device_code: '33600f52-46f8-493f-b8fb-336c63ea16de',
  user_code: 'NJAD-ATZC',
  verification_uri: 'https://hf.co/oauth/device',
  expires_in: 300,
}
const PENDING_400 = { error: 'authorization_pending', error_description: 'Device code pending, not yet approved' }
const INVALID_400 = { error: 'invalid_grant', error_description: 'Invalid device code' }
const TOKEN_200 = {
  access_token: 'hf_oauth_fixture_access_0000000001',
  token_type: 'bearer',
  expires_in: 28800,
  scope: 'openid profile inference-api',
  refresh_token: 'hf_oauth_fixture_refresh_0000000001',
}
const WHOAMI_200 = { type: 'user', name: 'fixture-user', fullname: 'Fixture User' }

section('1 · client id: pin > stored registration > ONE self-registration')
{
  let registrations = 0
  const seen: { url: string; body: string; method: string }[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    seen.push({ url: u, body: String(init?.body ?? ''), method: String(init?.method ?? 'GET') })
    if (u.endsWith('/oauth/register')) {
      registrations++
      return jsonResponse(201, REGISTER_201)
    }
    return jsonResponse(404, {})
  }) as typeof fetch
  check('no stored registration before the first connect', huggingfaceRegisteredClientId() === undefined)
  const first = await resolveHuggingfaceOauthClientId({ fetchImpl, now: () => 1_000 })
  check('a public client is registered and its id returned', first === REGISTER_201.client_id)
  const registerCall = seen.find(s => s.url.endsWith('/oauth/register'))
  const sent = JSON.parse(registerCall?.body ?? '{}') as Record<string, unknown>
  check(
    'the registration asks for a PUBLIC device-code client with the inference scope',
    sent.token_endpoint_auth_method === 'none' &&
      Array.isArray(sent.grant_types) &&
      (sent.grant_types as string[]).includes('urn:ietf:params:oauth:grant-type:device_code') &&
      sent.scope === HF_OAUTH_SCOPE &&
      sent.client_name === 'Mercury',
  )
  check('the registration hit the HUB base (fixture seam honoured)', registerCall?.url.startsWith('https://hub.fixture.example/') === true)
  const second = await resolveHuggingfaceOauthClientId({ fetchImpl })
  check('the stored registration is reused — registered exactly once', second === first && registrations === 1)
  check('the auth file records the client per hub base', huggingfaceRegisteredClientId() === first)
  const pinned = await resolveHuggingfaceOauthClientId({
    fetchImpl,
    env: { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'operator-app-id' } as NodeJS.ProcessEnv,
  })
  check('an operator pin wins over the stored registration', pinned === 'operator-app-id' && registrations === 1)
  const refusing = (async (url: unknown) =>
    String(url).endsWith('/oauth/register') ? jsonResponse(403, { error: 'nope' }) : jsonResponse(404, {})) as typeof fetch
  const other = { ...process.env, MERCURY_HUGGINGFACE_HUB_BASE: 'https://other-hub.fixture.example' } as NodeJS.ProcessEnv
  let threw = ''
  try {
    await resolveHuggingfaceOauthClientId({ fetchImpl: refusing, env: other })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a different hub base never reuses the id; a refused registration throws typed', threw.includes('registration refused (HTTP 403)'))
}

section('2 · the device-code ladder (observed shapes)')
{
  const bodies: string[] = []
  const urls: string[] = []
  const ladder = [jsonResponse(400, PENDING_400), jsonResponse(400, { error: 'slow_down' }), jsonResponse(200, TOKEN_200)]
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    urls.push(u)
    bodies.push(String(init?.body ?? ''))
    if (u.endsWith('/oauth/device')) return jsonResponse(200, DEVICE_200)
    if (u.endsWith('/oauth/token')) return ladder.shift() ?? jsonResponse(400, INVALID_400)
    if (u.endsWith('/api/whoami-v2')) return jsonResponse(200, WHOAMI_200)
    return jsonResponse(404, {})
  }) as typeof fetch
  const start = await startHuggingfaceDeviceAuth({ fetchImpl, now: () => 10_000 })
  check(
    'start decodes the observed fields; interval defaults to the RFC 5s; expiry from expires_in',
    start.deviceCode === DEVICE_200.device_code &&
      start.userCode === 'NJAD-ATZC' &&
      start.verificationUri === 'https://hf.co/oauth/device' &&
      start.verificationUriComplete === undefined &&
      start.intervalSec === 5 &&
      start.expiresAtMs === 310_000 &&
      start.clientId === REGISTER_201.client_id,
  )
  const deviceBody = bodies[urls.findIndex(u => u.endsWith('/oauth/device'))] ?? ''
  check('the device request carries client_id + scope as a form body', deviceBody.includes('client_id=') && deviceBody.includes('scope=openid+profile+inference-api'))
  const p1 = await pollHuggingfaceDeviceToken(start, { fetchImpl })
  const p2 = await pollHuggingfaceDeviceToken(start, { fetchImpl })
  const p3 = await pollHuggingfaceDeviceToken(start, { fetchImpl, now: () => 20_000 })
  check('pending → slow-down → authorized', p1.state === 'pending' && p2.state === 'slow-down' && p3.state === 'authorized')
  const tokenBody = bodies[urls.findIndex(u => u.endsWith('/oauth/token'))] ?? ''
  check(
    'the poll speaks the device_code grant with the client id',
    tokenBody.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code') &&
      tokenBody.includes(`device_code=${DEVICE_200.device_code}`) &&
      tokenBody.includes('client_id='),
  )
  if (p3.state === 'authorized') {
    check(
      'the token response decodes (expiry from expires_in, refresh + scope kept)',
      p3.tokens.accessToken === TOKEN_200.access_token &&
        p3.tokens.refreshToken === TOKEN_200.refresh_token &&
        p3.tokens.accessTokenExpiresAtMs === 20_000 + 28800 * 1000 &&
        p3.tokens.scope === TOKEN_200.scope,
    )
    const probe = await fetchHuggingfaceIdentity(p3.tokens.accessToken, { fetchImpl, now: () => 21_000 })
    const identity = probe.state === 'confirmed' ? probe.identity : undefined
    check('whoami yields the username + full name (never the token)', identity?.username === 'fixture-user' && identity?.fullName === 'Fixture User')
    writeHuggingfaceTokens(p3.tokens, identity)
  }
  const stored = huggingfaceStoredTokens()
  check('tokens persisted to the auth-scoped store', stored?.accessToken === TOKEN_200.access_token)
  const mode = statSync(huggingfaceAuthPathForDisplay()).mode & 0o777
  check('the auth file is mode 600', mode === 0o600, mode.toString(8))
  const account = resolveHuggingfaceAccount()
  check('the account reports the OAuth identity by username', account?.kind === 'oauth' && account.username === 'fixture-user' && account.label.includes('fixture-user'))
  check('the label never carries the token value', !(account?.label ?? '').includes('hf_oauth_fixture'))
  const bogus = await pollHuggingfaceDeviceToken({ deviceCode: 'bogus', clientId: start.clientId }, { fetchImpl })
  check('a bogus device code answers the observed invalid_grant as a typed denial', bogus.state === 'denied' && bogus.code === 'invalid_grant' && bogus.description === 'Invalid device code')
}

section('3 · refresh honesty')
{
  let call = 0
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    call++
    const body = String(init?.body ?? '')
    check('refresh speaks the refresh_token grant with client_id', body.includes('grant_type=refresh_token') && body.includes('refresh_token=') && body.includes('client_id='))
    return jsonResponse(200, { access_token: 'hf_oauth_fixture_access_0000000002', token_type: 'bearer', expires_in: 28800 })
  }) as typeof fetch
  const fresh = await refreshHuggingfaceTokens({ fetchImpl, now: () => 30_000 })
  check('a refresh success rotates the access token and RETAINS the refresh token the server omitted', fresh?.accessToken === 'hf_oauth_fixture_access_0000000002' && huggingfaceStoredTokens()?.refreshToken === TOKEN_200.refresh_token && call === 1)
  check('identity survives the rotation', resolveHuggingfaceAccount()?.username === 'fixture-user')
  const failing = (async () => {
    throw new Error('ECONNRESET')
  }) as typeof fetch
  const kept = await refreshHuggingfaceTokens({ fetchImpl: failing })
  check('a transport failure KEEPS the stored tokens', kept === undefined && huggingfaceStoredTokens()?.accessToken === 'hf_oauth_fixture_access_0000000002')
  const refusing = (async () => jsonResponse(400, { error: 'invalid_grant' })) as typeof fetch
  const dropped = await refreshHuggingfaceTokens({ fetchImpl: refusing })
  check('a refused refresh DROPS the tokens (no zombie identity)', dropped === undefined && huggingfaceStoredTokens() === undefined && resolveHuggingfaceAccount() === undefined)
}

section('4 · the credential ladder + the dispatch resolver')
{
  check('nothing ⇒ no credential', resolveHuggingfaceApiKey() === undefined && (await resolveHuggingfaceDispatchCredential()) === undefined)
  writeStoredHuggingfaceApiKey('hf_stored_fixture_token_00001')
  writeHuggingfaceTokenIdentity('hf_stored_fixture_token_00001', { username: 'stored-user', observedAtMs: 1 })
  check('stored paste resolves last with its observed identity', resolveHuggingfaceApiKey()?.source === 'stored' && resolveHuggingfaceAccount()?.username === 'stored-user')
  writeHuggingfaceTokenIdentity('hf_other_token_000000000002', { username: 'someone-else', observedAtMs: 2 })
  check('an identity recorded for a DIFFERENT token never dresses the stored one', resolveHuggingfaceAccount()?.username === undefined)
  writeHuggingfaceTokenIdentity('hf_stored_fixture_token_00001', { username: 'stored-user', observedAtMs: 3 })
  writeHuggingfaceTokens({ accessToken: 'hf_oauth_fixture_access_0000000003', refreshToken: 'rt', accessTokenExpiresAtMs: 1_000_000 }, { username: 'oauth-user', observedAtMs: 4 })
  check('OAuth outranks the stored paste', resolveHuggingfaceApiKey()?.source === 'oauth' && resolveHuggingfaceAccount()?.username === 'oauth-user')
  const envKey = resolveHuggingfaceApiKey({ ...process.env, HF_TOKEN: 'hf_env_fixture_token_000001' })
  check('HF_TOKEN env wins over everything', envKey?.source === 'env')
  // Dispatch: under the one-day margin the resolver refreshes; a refused
  // refresh drops to the next rung (the stored paste).
  let refreshed = 0
  const rotating = (async () => {
    refreshed++
    return jsonResponse(200, { access_token: 'hf_oauth_fixture_access_0000000004', expires_in: 28800 })
  }) as typeof fetch
  const untouched = await resolveHuggingfaceDispatchCredential({ fetchImpl: rotating, now: () => 0 })
  check('a token outside the margin is used as-is (no refresh churn)', refreshed === 0 && untouched?.apiKey === 'hf_oauth_fixture_access_0000000003')
  const credential = await resolveHuggingfaceDispatchCredential({ fetchImpl: rotating, now: () => 1_000_000 - 5 * 60 * 1000 })
  check('the dispatch resolver refreshes an OAuth token inside the fifteen-minute margin', refreshed === 1 && credential?.apiKey === 'hf_oauth_fixture_access_0000000004')
  const refusing = (async () => jsonResponse(401, { error: 'invalid_grant' })) as typeof fetch
  const fallback = await resolveHuggingfaceDispatchCredential({ fetchImpl: refusing, now: () => 1_000_000 + 28800 * 1000 })
  check('a refused dispatch-time refresh drops the OAuth rung and falls to the stored paste', fallback?.apiKey === 'hf_stored_fixture_token_00001' && huggingfaceStoredTokens() === undefined)
  check('the masked tail is the only key-derived display text', huggingfaceKeyTail('hf_stored_fixture_token_00001') === '0001' && huggingfaceKeyTail('short') === '')
}

section('5 · slots · usability · usage shape · routed removal')
{
  writeHuggingfaceTokens({ accessToken: 'hf_oauth_fixture_access_0000000005' }, { username: 'oauth-user', observedAtMs: 5 })
  // A fabricated provider snapshot (the slots-usage prover's double): the
  // derivation consults only these descriptions — never a live adapter, so
  // the machine's keychain is never read.
  const providers = [
    {
      id: 'huggingface',
      available: true,
      transport: 'openai-compat-chat-completions',
      description: { account: { kind: 'provider-oauth', label: 'Hugging Face account (oauth-user)' } },
    },
    {
      id: 'local',
      available: false,
      reason: 'no-server:local',
      transport: 'openai-compat-chat-completions',
      description: { account: { kind: 'none', label: 'no local server discovered' } },
    },
  ] as unknown as Parameters<typeof deriveFamilySlotGroups>[0]
  const groups = deriveFamilySlotGroups(providers, {
    huggingfaceEnvKey: () => undefined,
    localAccount: () => undefined,
  })
  const hf = groups.find(g => g.family.id === 'huggingface')
  check('the board carries a Hugging Face group', hf !== undefined)
  const oauthSlot = hf?.slots.find(s => s.id === 'huggingface:oauth')
  const storedSlot = hf?.slots.find(s => s.id === 'huggingface:stored-key')
  check('the OAuth slot is active and named by username', oauthSlot?.active === true && oauthSlot.identity.includes('oauth-user') && oauthSlot.signedIn)
  check('the stored token slot is shadowed by the OAuth sign-in', storedSlot?.active === false && (storedSlot.stateNote ?? '').includes('OAuth'))
  check('no slot carries a token value', (hf?.slots ?? []).every(s => !s.identity.includes('hf_oauth_fixture') && !s.identity.includes('hf_stored_fixture_token_00001')))
  const withEnv = deriveFamilySlotGroups(providers, {
    huggingfaceEnvKey: () => 'hf_env_fixture_token_000001',
    localAccount: () => undefined,
  }).find(g => g.family.id === 'huggingface')
  const localGroup = groups.find(g => g.family.id === 'local')
  check('the local family renders its honest absent row (no slots, present group)', localGroup !== undefined && localGroup.slots.length === 0 && localGroup.family.credentialed === false)
  check('an env pin is its own shell-owned slot and shadows the rest', withEnv?.slots.find(s => s.id === 'huggingface:env-key')?.envPinned === true && withEnv.slots.find(s => s.id === 'huggingface:oauth')?.active === false)
  const usability = resolveProviderUsability({
    anthropicApiKey: () => null,
    anthropicSubscriber: () => false,
    anthropicLimitStatus: () => 'allowed',
    gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account' }),
    zaiKeyPresent: () => false,
    huggingfaceAccount: () => ({ kind: 'oauth' }),
    localServerPresent: () => false,
  })
  check('usability: an OAuth sign-in is a usable oauth credential', usability.huggingface.usable && usability.huggingface.credential === 'oauth')
  check('usability: no local server ⇒ the typed blocker names the probe route', !usability.local.usable && usability.local.blockers[0]!.includes('Ollama'))
  const usage = activeSourceUsage({ model: 'huggingface/openai/gpt-oss-120b', reads: { huggingfaceAccount: () => resolveHuggingfaceAccount(), spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }) } })
  check('usage: the api-spend shape with the stated spend-API absence and the sign-in tier', usage.shape === 'api-spend' && usage.sourceKind === 'oauth' && usage.absence === HUGGINGFACE_USAGE_ABSENCE_NOTE && usage.tier === 'Hugging Face sign-in')
  const none = activeSourceUsage({ model: 'huggingface/openai/gpt-oss-120b', reads: { huggingfaceAccount: () => undefined, spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }) } })
  check('usage: no credential ⇒ the honest none shape', none.shape === 'none' && none.sourceKind === 'none')
  const removal = executeSlotRemoval(oauthSlot!)
  check('removal routes to the owning store and says where to revoke', removal.mutated && removal.note.includes('Connected applications') && huggingfaceStoredTokens() === undefined)
  const removedKey = executeSlotRemoval(storedSlot!)
  check('the stored token clears through its own store', removedKey.mutated && resolveHuggingfaceApiKey() === undefined)
  const file = JSON.parse(readFileSync(huggingfaceAuthPathForDisplay(), 'utf8')) as Record<string, unknown>
  check('the self-registered client survives disconnects (one registration per scope)', typeof (file.registeredClient as { clientId?: string })?.clientId === 'string')
}

section('6 · transport honesty: unreachable is typed, never a throw or a refusal')
{
  const down: typeof fetch = async () => {
    throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:443')
  }
  // The poll loop's owner awaits this in a bare loop — a rejection killed
  // the connect screen mid-wait. Transport now answers typed.
  const poll = await pollHuggingfaceDeviceToken({ deviceCode: 'dc', clientId: 'cid' }, { fetchImpl: down })
  check('a transport fault polls as the typed unreachable (never a throw)', poll.state === 'unreachable' && /ECONNREFUSED/.test(poll.state === 'unreachable' ? poll.message : ''))
  // whoami: a REFUSED credential and an UNREACHABLE Hub are different facts.
  const refuse401: typeof fetch = async () => new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 })
  const refused = await fetchHuggingfaceIdentity('hf_wrong', { fetchImpl: refuse401 })
  const unreachable = await fetchHuggingfaceIdentity('hf_fine', { fetchImpl: down })
  check('an invalid token is a typed refusal carrying the status', refused.state === 'refused' && refused.status === 401)
  check('a dead network is the typed unreachable carrying the fault', unreachable.state === 'unreachable' && /ECONNREFUSED/.test(unreachable.state === 'unreachable' ? unreachable.message : ''))
  check('the two outcomes are distinguishable (the conflation class)', refused.state !== unreachable.state)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
