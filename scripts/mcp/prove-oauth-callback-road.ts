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
type Mock = { base: string; seen: Seen; tokenMode: 'ok' | 'refuse'; issSupported: boolean; authorizationServer?: string; stop: () => void }
function mockServer(name: string): Mock {
  const mock = { seen: {} as Seen, tokenMode: 'ok' as 'ok' | 'refuse', issSupported: true, authorizationServer: undefined as string | undefined } as Mock
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

clearTimeout(watchdog)
console.log(failures === 0 ? '\nPASS prove-oauth-callback-road' : `\nFAIL prove-oauth-callback-road (${failures})`)
process.exit(failures === 0 ? 0 : 1)
