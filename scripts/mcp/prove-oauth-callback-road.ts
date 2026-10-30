#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-oauth-road-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { performMCPOAuthFlow } = await import('../../src/services/mcp/auth.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — oauth road prover exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()
const freePort = (): Promise<number> =>
  new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

type Seen = Record<string, string | null>
type Mock = { base: string; seen: Seen; tokenMode: 'ok' | 'refuse'; tokenHits: number; issSupported: boolean; authorizationServer?: string; stop: () => void }
function mockServer(name: string): Mock {
  const mock = { seen: {} as Seen, tokenMode: 'ok' as 'ok' | 'refuse', tokenHits: 0, issSupported: true, authorizationServer: undefined as string | undefined } as Mock
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      mock.seen[`${name} ${req.method} ${url.pathname}`] = req.headers.get('x-org')
      const base = mock.base
      if (url.pathname === '/mcp') return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } })
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${base}/mcp`, authorization_servers: [mock.authorizationServer ?? base] })
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: mock.issSupported,
        })
      }
      if (url.pathname === '/register') {
        const body = (await req.json()) as { redirect_uris: string[] }
        return Response.json({ client_id: 'cid', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, { status: 201 })
      }
      if (url.pathname === '/token') {
        await req.text()
        mock.tokenHits++
        return mock.tokenMode === 'ok'
          ? Response.json({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' })
          : Response.json({ error: 'invalid_grant', error_description: 'the code was not accepted' }, { status: 400 })
      }
      return new Response('nf', { status: 404 })
    },
  })
  mock.base = `http://127.0.0.1:${server.port}`
  mock.stop = () => server.stop(true)
  return mock
}

type Drive = (authorizeUrl: URL, callback: string, submitPasted: ((url: string) => void) | undefined) => Promise<string>
async function flow(label: string, mock: Mock, drive: Drive, config: Record<string, unknown> = {}): Promise<{ outcome: string; note: string }> {
  const port = await freePort()
  const callback = `http://127.0.0.1:${port}/callback`
  let note = ''
  let submitPasted: ((url: string) => void) | undefined
  const run = performMCPOAuthFlow(
    label.replace(/\W+/g, '-'),
    { type: 'http', url: `${mock.base}/mcp`, oauth: { callbackPort: port }, ...config } as never,
    (url: string) => {
      void drive(new URL(url), callback, submitPasted).then(text => {
        note = text
      })
    },
    undefined,
    { skipBrowserOpen: true, onWaitingForCallback: submit => { submitPasted = submit } },
  )
  const outcome = await Promise.race([
    run.then(() => 'RESOLVED', (error: Error) => `REJECTED: ${error.message}`),
    new Promise<string>(resolve => setTimeout(() => resolve('STILL WAITING after 8s'), 8000)),
  ])
  await new Promise(resolve => setTimeout(resolve, 200))
  return { outcome, note }
}
const redirect = async (callback: string, params: Record<string, string>): Promise<{ status: number; heading: string }> => {
  const response = await fetch(`${callback}?${new URLSearchParams(params)}`)
  const text = await response.text()
  return { status: response.status, heading: /<h1>(.*?)<\/h1>/.exec(text)?.[1] ?? '' }
}

console.log('the MCP OAuth road: configured headers on the authorization requests, the RFC 9207 iss parameter, stray callback requests, the browser page')

console.log('\n[1] configured headers ride on the authorization requests at the server\'s origin, and nowhere else')
{
  const same = mockServer('same')
  same.issSupported = false
  const result = await flow('headers same origin', same, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    await redirect(callback, { code: 'C1', state, iss: same.base })
    return ''
  }, { headers: { 'X-Org': 'acme' } })
  check('the sign-in completes', result.outcome === 'RESOLVED', result.outcome)
  for (const leg of ['GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server', 'POST /register', 'POST /token']) {
    check(`X-Org rides on ${leg}`, same.seen[`same ${leg}`] === 'acme', String(same.seen[`same ${leg}`]))
  }
  same.stop()

  const resource = mockServer('resource')
  const authority = mockServer('authority')
  authority.issSupported = false
  resource.authorizationServer = authority.base
  const split = await flow('headers other origin', resource, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    await redirect(callback, { code: 'C2', state, iss: authority.base })
    return ''
  }, { headers: { 'X-Org': 'acme' } })
  check('a sign-in whose authorization server lives elsewhere completes', split.outcome === 'RESOLVED', split.outcome)
  check('the header rides to the server\'s own origin', resource.seen['resource GET /.well-known/oauth-protected-resource/mcp'] === 'acme', JSON.stringify(resource.seen))
  const elsewhere = Object.entries(authority.seen).filter(([, value]) => value !== null)
  check('…and never to the authorization server on another origin', Object.keys(authority.seen).length >= 2 && elsewhere.length === 0, JSON.stringify(authority.seen))
  resource.stop()
  authority.stop()
}

console.log('\n[2] the RFC 9207 iss parameter reaches the token exchange (https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4)')
{
  const as = mockServer('iss')
  const standard = await flow('iss standard', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    const page = await redirect(callback, { code: 'C3', state, iss: as.base })
    return page.heading
  })
  check('a server that advertises iss support: the callback\'s iss is forwarded and the sign-in completes', standard.outcome === 'RESOLVED', standard.outcome)
  const tokenHitsBefore = as.tokenHits
  const wrong = await flow('iss wrong', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    await redirect(callback, { code: 'C4', state, iss: 'https://evil.example' })
    return ''
  })
  check('a callback whose iss names another issuer is refused before the code is redeemed', wrong.outcome.startsWith('REJECTED') && /issuer/i.test(wrong.outcome) && wrong.outcome.includes('evil.example'), wrong.outcome)
  check('…and the token endpoint was never asked', as.tokenHits === tokenHitsBefore, `${as.tokenHits - tokenHitsBefore} token request(s)`)
  const pasted = await flow('iss pasted', as, async (authorize, callback, submitPasted) => {
    const state = authorize.searchParams.get('state') ?? ''
    submitPasted?.(`${callback}?code=C5&state=${state}&iss=${encodeURIComponent(as.base)}`)
    return 'pasted'
  })
  check('a pasted callback URL carries its iss the same way', pasted.outcome === 'RESOLVED', pasted.outcome)
  as.stop()
}

console.log('\n[3] a request to the callback that carries no code and no error is answered and ignored; the sign-in stays alive')
{
  const as = mockServer('stray')
  for (const [label, method] of [['OPTIONS', 'OPTIONS'], ['HEAD', 'HEAD'], ['GET', 'GET']] as const) {
    const result = await flow(`stray ${label}`, as, async (authorize, callback) => {
      const state = authorize.searchParams.get('state') ?? ''
      const stray = await fetch(callback, { method }).then(r => r.status, () => 0)
      const real = await redirect(callback, { code: 'C6', state, iss: as.base }).then(r => r.status, () => 0)
      return `stray ${stray}, real ${real}`
    })
    check(`a stray ${label} /callback is answered without a body and the real redirect still completes the sign-in`, result.outcome === 'RESOLVED' && /stray (204|400), real 200/.test(result.note), `${result.outcome} | ${result.note}`)
  }
  const injected = await flow('stray error wrong state', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    const stray = await redirect(callback, { error: 'access_denied', state: 'not-ours' })
    const real = await redirect(callback, { code: 'C7', state, iss: as.base })
    return `stray ${stray.status} ${stray.heading}, real ${real.status}`
  })
  check('an error response whose state is not ours is answered 400 and does not end the sign-in', injected.outcome === 'RESOLVED' && injected.note.startsWith('stray 400'), `${injected.outcome} | ${injected.note}`)
  const denied = await flow('error right state', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    const page = await redirect(callback, { error: 'access_denied', error_description: 'the user said no', state })
    return page.heading
  })
  check('an error response with our state ends the sign-in with the error named', denied.outcome.includes('access_denied') && denied.outcome.includes('the user said no'), denied.outcome)
  const csrf = await flow('code wrong state', as, async (authorize, callback) => {
    const page = await redirect(callback, { code: 'C8', state: 'not-ours', iss: as.base })
    return `${page.status} ${page.heading}`
  })
  check('a code with a state that is not ours is refused and the sign-in ends', csrf.outcome.includes('state mismatch') && csrf.note.startsWith('400'), `${csrf.outcome} | ${csrf.note}`)
  as.stop()
}

console.log('\n[4] the browser page says what happened, after the token exchange')
{
  const as = mockServer('page')
  as.tokenMode = 'refuse'
  const refused = await flow('page refused', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    const page = await redirect(callback, { code: 'C9', state, iss: as.base })
    return `${page.status} ${page.heading}`
  })
  check('a refused exchange rejects the sign-in with the server\'s words', refused.outcome.startsWith('REJECTED') && refused.outcome.includes('the code was not accepted'), refused.outcome)
  check('…and the browser page says the sign-in failed, never successful', refused.note.startsWith('400 Sign-in failed'), refused.note)
  as.tokenMode = 'ok'
  const ok = await flow('page ok', as, async (authorize, callback) => {
    const state = authorize.searchParams.get('state') ?? ''
    const before = as.tokenHits
    const page = await redirect(callback, { code: 'C10', state, iss: as.base })
    return `${page.status} ${page.heading} after ${as.tokenHits - before} token request(s)`
  })
  check('a completed exchange shows the success page, and only once the token endpoint has answered', ok.outcome === 'RESOLVED' && ok.note === '200 Authentication successful after 1 token request(s)', `${ok.outcome} | ${ok.note}`)
  as.stop()
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nPASS prove-oauth-callback-road' : `\nFAIL prove-oauth-callback-road (${failures})`)
process.exit(failures === 0 ? 0 : 1)
