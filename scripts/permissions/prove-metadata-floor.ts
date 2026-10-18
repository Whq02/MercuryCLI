import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'metadata-floor-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const load = (file: string) => import(pathToFileURL(join(root, file)).href)
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
const { decideToolPermission } = await load('src/utils/permissions/decision/engine.ts')
const { WebFetchTool } = await load('src/tools/WebFetchTool/WebFetchTool.ts')
const { BrowserTool } = await load('src/tools/BrowserTool/BrowserTool.ts')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const hosts = ['169.254.169.254', '169.254.170.2', '169.254.169.253', '100.100.100.200', '[fd00:ec2::254]', 'metadata.google.internal', 'metadata.goog', '169.254.0.1', '169.254.255.255', '2852039166', '0xa9fea9fe', '0251.0376.0251.0376', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[::169.254.169.254]', '[64:ff9b::169.254.169.254]', '[::ffff:0:169.254.169.254]', '[::100.100.100.200]', '[64:ff9b::100.100.100.200]']
const context = (mode: string) => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { session: ['WebFetch', 'Browser'] } } }), options: {}, messages: [] })
try {
  console.log('refusals')
  for (const mode of ['default', 'implement', 'sovereign']) for (const host of hosts) {
    const url = `http://${host}/latest/meta-data/`
    for (const [tool, input] of [[WebFetchTool, { url }], [BrowserTool, { op: 'open', url }]] as Array<[any, Record<string, unknown>]>) {
      const result = (await decideToolPermission(tool, input, context(mode))).decision
      check(`${mode} ${tool.name} ${host}`, result.behavior === 'deny' && /metadata/i.test(result.message ?? ''), `${result.behavior}: ${result.message ?? ''}`)
    }
  }
  const { metadataSafeAddresses } = await load('src/tools/WebFetchTool/privateHost.ts')
  if (typeof metadataSafeAddresses !== 'function') check('DNS metadata guard exists', false, 'base has no guard')
  else {
    for (const addresses of [[{ address: '169.254.169.254', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '100.100.100.200', family: 4 }], [{ address: '::ffff:a9fe:a9fe', family: 6 }], []]) {
      let reason = ''
      try { await metadataSafeAddresses('http://fixture.test/', async () => addresses) } catch (error) { reason = String(error) }
      check('hostname resolving to metadata or no addresses refuses', /metadata/.test(reason), reason)
    }
    let failedDns = ''
    try { await metadataSafeAddresses('http://fixture.test/', async () => { throw new Error('fixture DNS fault') }) } catch (error) { failedDns = String(error) }
    check('DNS failure refuses before connection', /DNS.*failed/.test(failedDns), failedDns)
  }
  const { fetchPage } = await load('src/tools/WebFetchTool/fetchTransport.ts')
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest/' }); res.end() }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(req.url === '/robots.txt' ? '' : 'loopback-control') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const local = 'http://127.0.0.1:' + port
  try {
    const control = await fetchPage(local + '/', new AbortController().signal)
    check('ordinary loopback fetch still works', Buffer.from(control.data ?? '').toString().includes('loopback-control'))
    let redirectRefusal = ''
    try { await fetchPage(local + '/redirect', new AbortController().signal) } catch (error) { redirectRefusal = String(error) }
    check('redirect metadata is refused, not offered as a follow-up URL', /metadata/.test(redirectRefusal), redirectRefusal)
    const proxyModulePath = join(root, 'src/services/browser/metadataProxy.ts')
    let proxyModule: any
    try { proxyModule = await import(pathToFileURL(proxyModulePath).href) } catch { proxyModule = null }
    if (!proxyModule) check('browser connection-time metadata guard exists', false)
    else {
      const refused: string[] = []
      const proxy = await proxyModule.startMetadataProxy((reason: string) => refused.push(reason))
      const through = (path: string, method = 'GET') => new Promise<{ status: number; text: string }>((resolve, reject) => {
        const socket = connect(proxy.port, '127.0.0.1')
        socket.setTimeout(500, () => { socket.destroy(); resolve({ status: 0, text: 'timeout' }) })
        let text = ''
        socket.on('connect', () => socket.write(method + ' ' + path + ' HTTP/1.1\r\nHost: fixture\r\nReferer: ' + local + '/\r\nConnection: close\r\n\r\n'))
        socket.on('data', chunk => {
          text += chunk
          if (/^HTTP\/1.1 302 /.test(text) && text.includes('\r\n\r\n')) {
            resolve({ status: 302, text })
            socket.destroy()
          }
        })
        socket.on('error', reject)
        socket.on('end', () => resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1] ?? 0), text }))
      })
      try {
        const ordinary = await through(local + '/')
        check('browser proxy preserves ordinary loopback HTTP', ordinary.status === 200 && ordinary.text.includes('loopback-control'))
        const redirect = await through(local + '/redirect')
        const destination = /location: ([^\r\n]+)/i.exec(redirect.text)?.[1] ?? ''
        const followed = await through(destination)
        check('browser redirect and subrequest cannot enter metadata', redirect.status === 302 && followed.status === 403 && /metadata/.test(followed.text), followed.text)
        for (const host of hosts) {
          const response = await through('http://' + host + '/subrequest')
          check('browser subrequest refuses ' + host, response.status === 403 && /metadata/.test(response.text), response.text)
        }
        const count = hits
        const blocked = await through('http://169.254.169.254/latest/')
        check('browser proxy refuses before any metadata connection', blocked.status === 403 && /metadata/.test(blocked.text) && hits === count, blocked.text)
        const tunnel = await through('169.254.169.254:443', 'CONNECT')
        check('HTTPS CONNECT to metadata is refused', tunnel.status === 403 && /metadata/.test(tunnel.text), tunnel.text)
      } finally { proxy.close() }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  const axios = (await import(pathToFileURL(join(root, 'node_modules/axios/index.js')).href)).default
  const originalGet = axios.get
  const { tryStructuredFetch } = await load('src/tools/WebFetchTool/structuredHosts.ts')
  let structuredRefusal = ''
  let pinnedPageLookup = false
  let pinnedApiLookup = false
  axios.get = async (_url: string, cfg?: { lookup?: (h: string) => Promise<unknown> }) => {
    try {
      const res = await cfg?.lookup?.('169.254.169.254')
      if (Array.isArray(res)) pinnedApiLookup = true
    } catch {}
    return { status: 302, headers: { location: 'http://169.254.169.254/latest/' }, data: new ArrayBuffer(0) }
  }
  try { await tryStructuredFetch('https://github.com/fixture/project', new AbortController().signal) } catch (error) { structuredRefusal = String(error) }
  axios.get = async (_url: string, cfg?: { lookup?: (h: string) => Promise<unknown> }) => {
    try {
      const res = await cfg?.lookup?.('169.254.169.254')
      if (Array.isArray(res)) pinnedPageLookup = true
    } catch {}
    return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, data: new ArrayBuffer(0) }
  }
  try { await fetchPage('http://127.0.0.1/robots.txt', new AbortController().signal, true) } finally { axios.get = originalGet }
  check('structured API metadata redirect refuses', /metadata/.test(structuredRefusal), structuredRefusal)
  check('fetchPage and structuredHosts pin pre-checked addresses in socket lookup', pinnedPageLookup && pinnedApiLookup, `page=${pinnedPageLookup} api=${pinnedApiLookup}`)
  console.log('controls')
  for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[::1]/', 'http://169.253.169.254/']) {
    for (const [tool, input] of [[WebFetchTool, { url }], [BrowserTool, { op: 'open', url }]] as Array<[any, Record<string, unknown>]>) {
      const result = (await decideToolPermission(tool, input, context('sovereign'))).decision
      check(`${tool.name} non-metadata private destination stays available`, result.behavior === 'allow', result.message)
    }
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`metadata floor: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
