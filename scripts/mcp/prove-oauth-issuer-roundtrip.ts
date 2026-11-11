import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { MercuryMcpAuthProvider, getServerKey } = await import(`${root}/src/services/mcp/auth.ts`)
const { auth } = await import(`${root}/src/services/mcp/sdk.ts`)
const { getSecureStorage } = await import(`${root}/src/utils/secureStorage/index.ts`)
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail = ''): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? `: ${detail}` : ''}`)
}
let origin = ''
let tokenRequests = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (path.startsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    if (path === '/token') {
      tokenRequests++
      await request.text()
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 })
    }
    if (path === '/register') return Response.json({ client_id: 'fixture-client' }, { status: 201 })
    return new Response(null, { status: 404 })
  },
})
origin = `http://127.0.0.1:${server.port}`
const config = { type: 'http', url: `${origin}/mcp` }
const client = { client_id: 'fixture-client', client_secret: 'fixture-secret' }
const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 }
const provider = (name: string) => new MercuryMcpAuthProvider(name, config)
const warns: string[] = []
const warn = console.warn
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  if (line.includes('SEP-2352')) warns.push(line)
  warn(...args)
}
try {
  const saved = provider('stamped')
  saved.saveClientInformation({ ...client, issuer: origin })
  saved.saveTokens({ ...tokens, issuer: origin })
  const loaded = provider('stamped')
  check('client issuer survives a new provider and file-store read', loaded.clientInformation()?.issuer === origin)
  check('token issuer survives a new provider and file-store read', (await loaded.tokens())?.issuer === origin)
  check('the fresh-token refresh shortcut retains the token issuer', (await loaded.refreshAuthorization('fixture-refresh'))?.issuer === origin)
  const entry = getSecureStorage().read()?.mcpOAuth?.[getServerKey('stamped', config)]
  check('the file-backed entry keeps the two issuer stamps separately', entry?.clientIssuer === origin && entry?.tokenIssuer === origin)
  warns.length = 0
  const result = await auth(loaded, { serverUrl: config.url, fetchFn: loaded.fetchFn })
  check('the SDK authorizes against the loopback token endpoint', result === 'AUTHORIZED' && tokenRequests === 1, String(result))
  check('the SDK emits no SEP-2352 warning for a round-tripped sign-in', warns.length === 0, `${warns.length} warnings`)
  warns.length = 0
  const next = provider('stamped')
  await auth(next, { serverUrl: config.url, fetchFn: next.fetchFn })
  check('the next start remains quiet', warns.length === 0, `${warns.length} warnings`)
  next.saveClientInformation({ ...client, issuer: `${origin}/other` })
  check('saving another client issuer never relabels the existing token', next.clientInformation()?.issuer === `${origin}/other` && (await next.tokens())?.issuer === origin)

  const legacy = provider('legacy')
  legacy.saveClientInformation(client)
  legacy.saveTokens(tokens)
  const old = provider('legacy')
  const oldTokens = await old.tokens()
  check('a pre-stamp sign-in still loads its client, secret, access and refresh token', old.clientInformation()?.client_id === client.client_id && old.clientInformation()?.client_secret === client.client_secret && oldTokens?.access_token === tokens.access_token && oldTokens?.refresh_token === tokens.refresh_token && oldTokens?.issuer === undefined)
  warns.length = 0
  const first = await auth(old, { serverUrl: config.url, fetchFn: old.fetchFn })
  check('the SDK binds the legacy sign-in on its first use', first === 'AUTHORIZED' && warns.length === 2 && old.clientInformation()?.issuer === origin && (await old.tokens())?.issuer === origin, `${warns.length} warnings`)
  warns.length = 0
  const reopened = provider('legacy')
  await auth(reopened, { serverUrl: config.url, fetchFn: reopened.fetchFn })
  check('a legacy sign-in warns only once, not at every subsequent start', warns.length === 0, `${warns.length} warnings`)

  const expiring = provider('refresh')
  expiring.saveClientInformation({ ...client, issuer: origin })
  expiring.saveDiscoveryState({ authorizationServerUrl: origin })
  expiring.saveTokens({ ...tokens, expires_in: 0, issuer: origin })
  const refreshed = await expiring.tokens()
  check('the provider refresh road returns and stores the issuer', refreshed?.issuer === origin && (await provider('refresh').tokens())?.issuer === origin)
} finally {
  console.warn = warn
  server.stop(true)
}
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
