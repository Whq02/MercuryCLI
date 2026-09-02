#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-openrouter-oauth.ts
//  PROOF: the OpenRouter PKCE connect
//  state machine against a fixture rig — no real endpoint is ever touched:
//  every endpoint base is PINNED to a non-resolvable fixture host (the
//  fail-open law: an unpinned base falls open to the real credential estate)
//  and the exchange rides an injected fetch. Browser-mode begins create the
//  loopback listener opportunistically (a busy :1456 degrades to the paste
//  path BY DESIGN — the resilience contract); every completion here rides
//  the PASTE path, and completing via a real loopback redirect is a named
//  DEFERRED-LIVE item.
//    1. authorize URL: pinned base, S256 challenge derived from the
//       verifier, callback_url on the browser variant, key_label (and NO
//       callback_url) on the headless variant, no client id / state (the
//       documented protocol, fetched);
//    2. paste completion (full URL and bare code) → POST {api}/auth/keys
//       with {code, code_verifier, code_challenge_method:'S256'} → the
//       minted key persists auth-scoped, mode 600, source 'oauth';
//    3. resolution precedence: env OPENROUTER_API_KEY > OAuth-minted >
//       stored manual key;
//    4. a 403 exchange rejects with the honest expired-code copy;
//    5. disconnect drops ONLY the minted key; no surface ever carries the
//       key value.
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-openrouter-oauth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — OpenRouter PKCE connect (fixture rig)')
console.log('============================================================')

// Hermetic home + pinned bases (ALL of them — the fail-open law).
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENROUTER_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-openrouter-oauth-'))
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'

const accounts = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const {
  beginOpenrouterConnect,
  disconnectOpenrouterOauthKey,
  openrouterAuthPathForDisplay,
  readMintedOpenrouterKey,
  resolveOpenrouterAccount,
  resolveOpenrouterApiKey,
  resolveOpenrouterRequestAuth,
} = accounts

const FIXTURE_KEY = 'sk-or-v1-FIXTUREKEY0000000000'

interface ExchangeSeen {
  url: string
  body: Record<string, unknown>
}

function exchangeFetch(
  seen: ExchangeSeen[],
  respond: (body: Record<string, unknown>) => Response = () =>
    new Response(JSON.stringify({ key: FIXTURE_KEY }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    seen.push({ url: String(url), body })
    return respond(body)
  }) as unknown as typeof fetch
}

// ── 1. authorize URL shape (browser + headless variants) ────────────────────
{
  const handles = beginOpenrouterConnect({ skipBrowserOpen: true, fetchImpl: exchangeFetch([]), loopbackPort: 0 })
  const url = new URL(handles.authorizeUrl)
  check('authorize URL rides the PINNED base', handles.authorizeUrl.startsWith('https://fixture.invalid/auth?'))
  const challenge = url.searchParams.get('code_challenge') ?? ''
  check('S256 method stated', url.searchParams.get('code_challenge_method') === 'S256')
  check('browser variant carries a LITERAL-127.0.0.1 callback_url (matches the bound listener)', (url.searchParams.get('callback_url') ?? '').includes('http://127.0.0.1:'))
  check('no client id and no state (the documented protocol)', !url.searchParams.has('client_id') && !url.searchParams.has('state'))
  check('challenge present and base64url-shaped', /^[A-Za-z0-9_-]{40,50}$/.test(challenge))
  handles.cancel('shape leg done')
  await handles.result.catch(() => {})

  const headless = beginOpenrouterConnect({ mode: 'headless', skipBrowserOpen: true, fetchImpl: exchangeFetch([]) })
  const headlessUrl = new URL(headless.authorizeUrl)
  check('headless variant states key_label and NO callback_url', headlessUrl.searchParams.get('key_label') === 'Mercury' && !headlessUrl.searchParams.has('callback_url'))
  headless.cancel('shape leg done')
  await headless.result.catch(() => {})
}

// ── 2. paste completion (full URL) → exchange → persisted minted key ────────
{
  const seen: ExchangeSeen[] = []
  const handles = beginOpenrouterConnect({ skipBrowserOpen: true, fetchImpl: exchangeFetch(seen), loopbackPort: 0 })
  const challenge = new URL(handles.authorizeUrl).searchParams.get('code_challenge') ?? ''
  handles.completeWithRedirect('http://localhost:1456/auth/callback?code=FIXTURE-CODE-1')
  const ref = await handles.result
  check('exchange POSTed to the PINNED api base /auth/keys', seen.length === 1 && seen[0]!.url === 'https://fixture.invalid/api/v1/auth/keys')
  check('exchange body carries code + verifier + S256', seen[0]!.body.code === 'FIXTURE-CODE-1' && typeof seen[0]!.body.code_verifier === 'string' && seen[0]!.body.code_challenge_method === 'S256')
  const verifier = String(seen[0]!.body.code_verifier)
  check(
    'the challenge in the URL IS S256(verifier) — the PKCE binding',
    createHash('sha256').update(verifier).digest('base64url') === challenge,
  )
  check('resolved ref: oauth-key kind, no secret in the label', ref.kind === 'oauth-key' && !ref.label.includes(FIXTURE_KEY))
  const minted = readMintedOpenrouterKey()
  check('minted key persisted with mintedAtMs', minted?.key === FIXTURE_KEY && typeof minted?.mintedAtMs === 'number')
  const mode = statSync(openrouterAuthPathForDisplay()).mode & 0o777
  check('auth store mode 600', mode === 0o600, `mode ${mode.toString(8)}`)
  check('resolution source is oauth', resolveOpenrouterApiKey()?.source === 'oauth')
  const auth = resolveOpenrouterRequestAuth()
  check('request auth: pinned base + bearer header', auth?.baseUrl === 'https://fixture.invalid/api/v1' && auth?.headers.authorization === `Bearer ${FIXTURE_KEY}`)
}

// ── 3. resolution precedence: env > oauth > stored ──────────────────────────
{
  secrets.writeStoredOpenrouterApiKey('sk-or-v1-STOREDKEY000000000000')
  check('oauth outranks the stored manual key', resolveOpenrouterApiKey()?.source === 'oauth')
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-ENVKEY0000000000000000'
  check('env outranks everything (the louder word)', resolveOpenrouterApiKey()?.source === 'env')
  check('account ref labels the env source, never the value', resolveOpenrouterAccount()?.label === 'OpenRouter API key (env)')
  delete process.env.OPENROUTER_API_KEY
  disconnectOpenrouterOauthKey()
  check('disconnect drops ONLY the minted key — stored key still resolves', resolveOpenrouterApiKey()?.source === 'stored' && readMintedOpenrouterKey() === undefined)
  secrets.writeStoredOpenrouterApiKey(null)
  check('cleared store resolves to nothing', resolveOpenrouterApiKey() === undefined)
}

// ── 4. paste completion (bare code — the headless variant's paste) ──────────
{
  const seen: ExchangeSeen[] = []
  const handles = beginOpenrouterConnect({ mode: 'headless', skipBrowserOpen: true, fetchImpl: exchangeFetch(seen) })
  handles.completeWithRedirect('  FIXTURE-CODE-2  ')
  await handles.result
  check('bare-code paste exchanges (trimmed)', seen[0]?.body.code === 'FIXTURE-CODE-2')
  disconnectOpenrouterOauthKey()
}

// ── 5. a 403 exchange rejects with the honest expired-code copy ─────────────
{
  const rejecting = exchangeFetch([], () => new Response('{}', { status: 403 }))
  const handles = beginOpenrouterConnect({ skipBrowserOpen: true, fetchImpl: rejecting, loopbackPort: 0 })
  handles.completeWithRedirect('http://localhost:1456/auth/callback?code=EXPIRED')
  const outcome = await handles.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check('403 ⇒ rejected with the 10-minute expiry copy', typeof outcome === 'string' && outcome.includes('10 minutes'), String(outcome))
  check('nothing persisted on a failed exchange', readMintedOpenrouterKey() === undefined)
}

// ── 6. the loopback listener SURVIVES junk hits (real HTTP, ephemeral port) ──
{
  // OpenRouter's protocol has no state parameter, so any local port-scan or
  // stray tab can reach the loopback with a bogus code. A refused exchange
  // must answer 400 and KEEP LISTENING; the operator's real redirect then
  // completes the same in-flight sign-in.
  const seen: ExchangeSeen[] = []
  const notices: string[] = []
  const selectiveExchange: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    seen.push({ url: String(url), body })
    return body.code === 'REAL-CODE'
      ? new Response(JSON.stringify({ key: FIXTURE_KEY }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('{}', { status: 403 })
  }) as unknown as typeof fetch
  const handles = beginOpenrouterConnect({
    skipBrowserOpen: true,
    fetchImpl: selectiveExchange,
    loopbackPort: 0,
    onListenerIssue: message => notices.push(message),
  })
  let port: number | undefined
  for (let i = 0; i < 100 && port === undefined; i++) {
    port = handles.boundLoopbackPort()
    if (port === undefined) await new Promise(resolve => setTimeout(resolve, 10))
  }
  check('listener bound on the lane-scoped ephemeral port', typeof port === 'number' && port! > 0)
  const junk = await fetch(`http://127.0.0.1:${port}/auth/callback?code=JUNK-SCAN-HIT`)
  check('junk hit answers 400 with the still-waiting copy', junk.status === 400 && (await junk.text()).includes('still waiting'))
  check('the junk refusal surfaces as a listener note, not a flow abort', notices.length === 1 && notices[0]!.includes('still listening'))
  const real = await fetch(`http://127.0.0.1:${port}/auth/callback?code=REAL-CODE`)
  check('the REAL redirect then completes the SAME flow (200 connected)', real.status === 200 && (await real.text()).includes('connected'))
  const ref = await handles.result
  check('flow settles on the minted identity after surviving the junk hit', ref.kind === 'oauth-key')
  check('both codes exchanged in order against the pinned base', seen.length === 2 && seen[0]!.body.code === 'JUNK-SCAN-HIT' && seen[1]!.body.code === 'REAL-CODE' && seen.every(s => s.url.startsWith('https://fixture.invalid/')))
  check('the successful mint persisted', readMintedOpenrouterKey()?.key === FIXTURE_KEY)
  const dead = await fetch(`http://127.0.0.1:${port}/auth/callback?code=LATE`).then(
    () => 'answered',
    () => 'refused',
  )
  check('the listener closes after success (no lingering socket)', dead === 'refused')
  disconnectOpenrouterOauthKey()
}

// ── 6. an empty paste value rejects, never exchanges ────────────────────────
{
  const seen: ExchangeSeen[] = []
  const handles = beginOpenrouterConnect({ skipBrowserOpen: true, fetchImpl: exchangeFetch(seen) })
  handles.completeWithRedirect('   ')
  const outcome = await handles.result.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  check('empty paste ⇒ honest rejection, zero exchange calls', outcome !== 'resolved' && seen.length === 0)
}

// ── 7. the auth store never leaks into labels ───────────────────────────────
{
  const file = ((): string => {
    try {
      return readFileSync(openrouterAuthPathForDisplay(), 'utf8')
    } catch {
      return ''
    }
  })()
  check('display path accessor returns the path, not contents', openrouterAuthPathForDisplay().endsWith('.openrouter-auth.json'))
  check('post-disconnect store carries no minted key', !file.includes(FIXTURE_KEY))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} openrouter-oauth proof(s) failed`)
  process.exit(1)
}
console.log('✅ OPENROUTER PKCE CONNECT PROVEN (fixture rig; listener on an ephemeral port — the :1456 bind under a real browser = DEFERRED-LIVE)')
