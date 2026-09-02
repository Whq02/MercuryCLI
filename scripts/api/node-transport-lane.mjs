#!/usr/bin/env node
// ============================================================================
//  scripts/api/node-transport-lane.mjs — the NODE-lane transport battery.
//
//  Runs under the pinned Node runtime (the packaged product's runtime), NOT
//  under Bun: the Node arms of src/utils/proxy.ts have no other prover shadow.
//  Invoked by prove-node-transport-lane.ts, which first bundles the proxy
//  module (undici / axios / https-proxy-agent left external so the battery
//  and the module share ONE library instance) and passes the bundle path as
//  argv[2].
//
//  Everything is local: an in-process HTTP proxy fixture (CONNECT tunnels and
//  absolute-URI plain requests, both recorded) in front of an in-process HTTP
//  target. No real network, no real credentials.
// ============================================================================
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import axios from 'axios'
import * as undici from 'undici'

const bundlePath = process.argv[2]
if (!bundlePath) {
  console.error('usage: node node-transport-lane.mjs <proxy-bundle.mjs>')
  process.exit(2)
}
if (typeof Bun !== 'undefined') {
  console.error('this battery must run under node, not bun')
  process.exit(2)
}

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = title => console.log(`\n── ${title} ──`)

//
// Fixtures: a target server and a recording proxy in front of it
//

const target = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`ok:${req.url}`)
})
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
const targetPort = target.address().port
const targetUrl = `http://127.0.0.1:${targetPort}`

/** Every CONNECT tunnel and every absolute-URI request the proxy saw. */
const seen = []
const proxy = http.createServer((req, res) => {
  seen.push({ kind: 'request', url: req.url })
  let upstream
  try {
    upstream = new URL(req.url)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const forward = http.request(
    { host: upstream.hostname, port: upstream.port, path: `${upstream.pathname}${upstream.search}`, method: req.method, headers: req.headers },
    r2 => {
      res.writeHead(r2.statusCode ?? 502, r2.headers)
      r2.pipe(res)
    },
  )
  forward.on('error', () => {
    res.writeHead(502)
    res.end()
  })
  req.pipe(forward)
})
proxy.on('connect', (req, clientSocket, head) => {
  seen.push({ kind: 'connect', target: req.url })
  const [host, port] = req.url.split(':')
  const socket = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) socket.write(head)
    socket.pipe(clientSocket)
    clientSocket.pipe(socket)
  })
  socket.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => socket.destroy())
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const proxyPort = proxy.address().port
const proxyUrl = `http://127.0.0.1:${proxyPort}`
const sawTarget = () => seen.some(s => (s.kind === 'connect' && s.target === `127.0.0.1:${targetPort}`) || (s.kind === 'request' && s.url.startsWith(targetUrl)))

const clearProxyEnv = () => {
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']) delete process.env[name]
}
clearProxyEnv()
delete process.env.MERCURY_CLIENT_CERT
delete process.env.MERCURY_CLIENT_KEY
delete process.env.MERCURY_CLIENT_KEY_PASSPHRASE
delete process.env.MERCURY_PROXY_RESOLVES_HOSTS
delete process.env.NODE_EXTRA_CA_CERTS

const mod = await import(pathToFileURL(bundlePath).href)
const {
  getProxyFetchOptions,
  getApiDispatcher,
  getProxyAgent,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
  configureGlobalAgents,
  createAxiosInstance,
  getAddressFamily,
  clearProxyCache,
  getMTLSAgent,
  clearMTLSCache,
} = mod

const fetchText = async (url, init) => {
  const response = await undici.fetch(url, init)
  return response.text()
}

//
section('§0 the direct Node path (no proxy)')
{
  const direct = getProxyFetchOptions({ forAnthropicAPI: true })
  check('no proxy → the explicit API dispatcher (an undici Agent)', direct.dispatcher === getApiDispatcher() && direct.dispatcher?.constructor?.name === 'Agent')
  const before = seen.length
  const body = await fetchText(`${targetUrl}/direct`, { dispatcher: direct.dispatcher })
  check('a direct fetch reaches the target without the fixture', body === 'ok:/direct' && seen.length === before)
}

//
section('§1 HTTPS_PROXY set → getProxyFetchOptions returns the PROXY dispatcher and traffic traverses the fixture')
{
  process.env.HTTPS_PROXY = proxyUrl
  clearProxyCache()
  const opts = getProxyFetchOptions({ forAnthropicAPI: true })
  check('the dispatcher is the environment-aware proxy dispatcher (EnvHttpProxyAgent)', opts.dispatcher?.constructor?.name === 'EnvHttpProxyAgent', String(opts.dispatcher?.constructor?.name))
  check('…and NOT the direct API dispatcher', opts.dispatcher !== getApiDispatcher())
  check('memoized per URI', getProxyAgent(proxyUrl) === opts.dispatcher)
  const before = seen.length
  const body = await fetchText(`${targetUrl}/via-proxy`, { dispatcher: opts.dispatcher })
  check('the fetch through it reaches the target', body === 'ok:/via-proxy', body)
  check('the fixture saw the request (CONNECT tunnel or absolute-URI request)', seen.length > before && sawTarget(), JSON.stringify(seen.slice(before)))
}

//
section('§2a configureGlobalAgents() with a proxy installs the global dispatcher + the axios interceptor')
{
  process.env.HTTPS_PROXY = proxyUrl
  clearProxyCache()
  configureGlobalAgents()
  check('undici global dispatcher === the memoized proxy dispatcher', undici.getGlobalDispatcher() === getProxyAgent(proxyUrl))
  check("axios' own proxy support is disabled", axios.defaults.proxy === false)
  let before = seen.length
  const bareBody = await fetchText(`${targetUrl}/bare-undici`)
  check('bare undici fetch() (no dispatcher option) traverses the fixture', bareBody === 'ok:/bare-undici' && seen.length > before, JSON.stringify(seen.slice(before)))
  // Node's platform fetch is a DIFFERENT undici instance, but the
  // global-dispatcher slot is a shared well-known symbol, so the bare
  // platform fetch() rides the installed dispatcher too (on the pinned Node
  // major; the pairing law of §F5 is why the product's own path uses undici's
  // fetch, asserted above).
  before = seen.length
  try {
    const platformBody = await (await fetch(`${targetUrl}/bare-platform`)).text()
    check('bare PLATFORM global fetch() traverses the fixture too', platformBody === 'ok:/bare-platform' && seen.length > before, JSON.stringify(seen.slice(before)))
  } catch (err) {
    check('bare PLATFORM global fetch() traverses the fixture too', false, `rejected: ${err?.cause?.code ?? err?.code ?? err?.message}`)
  }
  before = seen.length
  const axiosBody = (await axios.get(`${targetUrl}/axios-global`)).data
  check('a global axios request routes through the tunnelling agent (fixture saw it)', axiosBody === 'ok:/axios-global' && seen.length > before, JSON.stringify(seen.slice(before)))
  // Idempotent: a second configure ejects the first interceptor (one interceptor, not two).
  configureGlobalAgents()
  const handlers = axios.interceptors.request.handlers.filter(h => h !== null)
  check('re-configuring leaves exactly ONE request interceptor installed', handlers.length === 1, `${handlers.length} handlers`)
}

//
section('§2b configureGlobalAgents() with mTLS only installs the mTLS dispatcher and the mTLS axios agent')
{
  clearProxyEnv()
  clearProxyCache()
  const dir = mkdtempSync(join(tmpdir(), 'node-lane-mtls-'))
  const certPath = join(dir, 'client.crt')
  const keyPath = join(dir, 'client.key')
  writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nMIIBfixture\n-----END CERTIFICATE-----\n')
  writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nMIIBfixture\n-----END PRIVATE KEY-----\n')
  process.env.MERCURY_CLIENT_CERT = certPath
  process.env.MERCURY_CLIENT_KEY = keyPath
  clearMTLSCache()
  configureGlobalAgents()
  const global = undici.getGlobalDispatcher()
  check('the global dispatcher is a plain undici Agent (the mTLS dispatcher), not the proxy agent', global?.constructor?.name === 'Agent' && global !== getApiDispatcher(), String(global?.constructor?.name))
  const mtlsAgent = getMTLSAgent()
  check('axios default httpsAgent === the mTLS agent', mtlsAgent !== undefined && axios.defaults.httpsAgent === mtlsAgent)
  check('axios proxy default was reset (not false) on the mTLS-only path', axios.defaults.proxy === undefined)
  const handlers = axios.interceptors.request.handlers.filter(h => h !== null)
  check('the proxy interceptor was ejected', handlers.length === 0, `${handlers.length} handlers`)
  const direct = getProxyFetchOptions({ forAnthropicAPI: true })
  check('fetch options: no proxy → the API dispatcher (which carries the TLS material)', direct.dispatcher === getApiDispatcher())
  delete process.env.MERCURY_CLIENT_CERT
  delete process.env.MERCURY_CLIENT_KEY
  clearMTLSCache()
}

//
section('§3 the WebSocket path under Node carries a real agent (the tunnelling factory)')
{
  process.env.HTTPS_PROXY = proxyUrl
  clearProxyCache()
  const agent = getWebSocketProxyAgent('wss://example.invalid/socket')
  check('getWebSocketProxyAgent returns an HttpsProxyAgent (tunnelling), not the dispatcher', agent?.constructor?.name === 'HttpsProxyAgent', String(agent?.constructor?.name))
  check('the tunnel connects to the configured proxy', agent?.connectOpts?.host === '127.0.0.1' && agent?.connectOpts?.port === proxyPort)
  check('getWebSocketProxyUrl returns the plain URL (the alternative runtime form)', getWebSocketProxyUrl('wss://example.invalid/socket') === proxyUrl)
  process.env.NO_PROXY = 'example.invalid'
  check('a bypassed host gets NO ws agent and NO ws url', getWebSocketProxyAgent('wss://example.invalid/socket') === undefined && getWebSocketProxyUrl('wss://example.invalid/socket') === undefined)
  delete process.env.NO_PROXY
  // The proxy-resolves-hosts flag: local DNS is skipped and the hostname is
  // handed over verbatim with the mapped family.
  process.env.MERCURY_PROXY_RESOLVES_HOSTS = '1'
  clearProxyCache()
  const resolving = getWebSocketProxyAgent('wss://example.invalid/socket')
  const lookup = resolving?.connectOpts?.lookup
  check('under MERCURY_PROXY_RESOLVES_HOSTS the tunnel agent carries a lookup override', typeof lookup === 'function')
  if (typeof lookup === 'function') {
    let got
    lookup('resolve-me.invalid', { family: 'IPv6' }, (err, address, family) => { got = { err, address, family } })
    check('…that hands the hostname back verbatim with the family mapped (IPv6 → 6)', got?.err === null && got?.address === 'resolve-me.invalid' && got?.family === 6, JSON.stringify(got))
  }
  // End-to-end: with the flag on, a request through the tunnel agent to a
  // hostname that does NOT resolve locally still reaches the proxy fixture
  // with the hostname handed over VERBATIM in the CONNECT payload — local
  // DNS is never consulted on the client (an unresolvable name would have
  // thrown ENOTFOUND before any bytes reached the fixture).
  {
    const before = seen.length
    const agentForRequest = getWebSocketProxyAgent('ws://l2c-never-resolves.invalid/x')
    await new Promise(resolve => {
      const req = http.request(
        { host: 'l2c-never-resolves.invalid', port: 80, path: '/x', agent: agentForRequest, timeout: 5000 },
        res => { res.resume(); resolve(undefined) },
      )
      req.on('error', () => resolve(undefined))
      req.on('timeout', () => { req.destroy(); resolve(undefined) })
      req.end()
    })
    const tunnelled = seen.slice(before).some(s2 => s2.kind === 'connect' && s2.target === 'l2c-never-resolves.invalid:80')
    check('resolves-hosts: an unresolvable hostname reaches the proxy VERBATIM (no local DNS)', tunnelled, JSON.stringify(seen.slice(before)))
  }
  delete process.env.MERCURY_PROXY_RESOLVES_HOSTS
  clearProxyCache()
  const plain = getWebSocketProxyAgent('wss://example.invalid/socket')
  check('without the flag no lookup override rides the tunnel agent', plain?.connectOpts?.lookup === undefined)
  // Structural: the two ws consumers pass the agent under `agent` (Node) and the URL under `proxy` (Bun).
  const mcp = readFileSync(new URL('../../src/services/mcp/client.ts', import.meta.url), 'utf8')
  check('mcp client: Node ws options carry `agent: proxyAgent` from getWebSocketProxyAgent', /getWebSocketProxyAgent\(url\)/.test(mcp) && /\{ agent: proxyAgent \}/.test(mcp) && !/proxy: proxyUrl \} : \{\}\) \}\n  let socket/.test(mcp))
  check('mcp client: Bun ws options carry the proxy URL from getWebSocketProxyUrl', /getWebSocketProxyUrl\(url\)/.test(mcp) && /\{ proxy: proxyUrl \}/.test(mcp))
}

//
// (§4, the AWS client proxy binding, retired with the gateway estate
// getAWSClientProxyConfig does not exist.)
section('§4 the retired AWS proxy binding stays retired')
{
  check('getAWSClientProxyConfig is gone from the proxy surface', mod.getAWSClientProxyConfig === undefined)
}

//
section('§5 NO_PROXY bypass: a bypassed host does NOT traverse the fixture')
{
  process.env.HTTPS_PROXY = proxyUrl
  process.env.NO_PROXY = '127.0.0.1'
  clearProxyCache()
  const opts = getProxyFetchOptions({ forAnthropicAPI: true })
  check('still the proxy dispatcher (bypass is per request, inside it)', opts.dispatcher?.constructor?.name === 'EnvHttpProxyAgent')
  const before = seen.length
  const body = await fetchText(`${targetUrl}/bypassed`, { dispatcher: opts.dispatcher })
  check('the request still succeeds (direct)', body === 'ok:/bypassed', body)
  check('the fixture did NOT see it', seen.length === before, JSON.stringify(seen.slice(before)))
  // The uppercase-first asymmetry: NO_PROXY wins over no_proxy for the dispatcher.
  process.env.no_proxy = 'nothing.invalid'
  clearProxyCache()
  const asym = getProxyFetchOptions({ forAnthropicAPI: true })
  const before2 = seen.length
  const body2 = await fetchText(`${targetUrl}/bypassed-upper`, { dispatcher: asym.dispatcher })
  check('NO_PROXY (uppercase) wins over no_proxy for the dispatcher (uppercase-first)', body2 === 'ok:/bypassed-upper' && seen.length === before2, JSON.stringify(seen.slice(before2)))
  delete process.env.no_proxy
  delete process.env.NO_PROXY
  // createAxiosInstance: extra = AGENT options; the bypass test runs on the url field.
  clearProxyCache()
  const instance = createAxiosInstance({ timeout: 4321 })
  const handlers = instance.interceptors.request.handlers.filter(h => h !== null)
  check('createAxiosInstance installs one bypass-aware interceptor', handlers.length === 1)
  const routed = handlers[0]?.fulfilled?.({ url: `${targetUrl}/x`, headers: {} })
  check('…which sets BOTH agents to the per-instance tunnelling agent (extra merged into its options)', routed?.httpAgent?.constructor?.name === 'HttpsProxyAgent' && routed?.httpsAgent === routed?.httpAgent && routed?.httpAgent?.connectOpts?.timeout === 4321)
  process.env.NO_PROXY = '127.0.0.1'
  const bypassed = handlers[0]?.fulfilled?.({ url: `${targetUrl}/x`, headers: {} })
  check('…and on bypass (tested on the url field) routes direct/mTLS instead', bypassed?.httpAgent === undefined && bypassed?.httpsAgent === getMTLSAgent())
  delete process.env.NO_PROXY
}

//
section('§6 the SDK client construction receives the transport fetch options (structural)')
{
  const client = readFileSync(new URL('../../src/services/api/client.ts', import.meta.url), 'utf8')
  check('client.ts passes fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }) into the shared SDK options', /fetchOptions: getProxyFetchOptions\(\{ forAnthropicAPI: true \}\)/.test(client))
  check('the same shared options reach the first-party constructor', /\.\.\.sharedOptions,\n\s+apiKey:/.test(client))
}

//
section('§7 getAddressFamily over the DNS lookup-options domain')
{
  check('0/4/6 pass through', getAddressFamily({ family: 0 }) === 0 && getAddressFamily({ family: 4 }) === 4 && getAddressFamily({ family: 6 }) === 6)
  check("'IPv6' → 6", getAddressFamily({ family: 'IPv6' }) === 6)
  check("'IPv4' → 4 and undefined → 4", getAddressFamily({ family: 'IPv4' }) === 4 && getAddressFamily({}) === 4)
  let threw = false
  try { getAddressFamily({ family: 5 }) } catch { threw = true }
  check('anything else throws', threw)
}

//
clearProxyEnv()
clearProxyCache()
await new Promise(resolve => proxy.close(resolve))
await new Promise(resolve => target.close(resolve))
try { await undici.getGlobalDispatcher().close?.() } catch { /* best effort */ }

console.log('')
if (failures > 0) {
  console.log(`❌ NODE TRANSPORT LANE RED — ${failures} failing check(s)`)
  process.exit(1)
}
console.log('✅ NODE TRANSPORT LANE GREEN')
process.exit(0)
