import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
let requests = 0
const server = createServer((req, res) => {
  requests++
  if (!req.headers['x-fixture-url']) {
    res.statusCode = req.url === '/curl-error' ? 404 : 200
    if (req.url === '/slow') { res.write('source words'); setTimeout(() => res.end(' done'), 2500); return }
    res.end(req.url === '/large' ? 'source words\n'.repeat(5000) : 'source words')
    return
  }
  const url = new URL(String(req.headers['x-fixture-url']))
  if (url.pathname === '/robots.txt') {
    if (url.hostname.startsWith('robots-reset')) { req.socket.destroy(); return }
    res.end('User-agent: *\nDisallow: /maps')
  } else if (url.pathname === '/reset') req.socket.destroy()
  else if (url.pathname === '/timeout') return
  else { res.statusCode = url.pathname === '/406' ? 406 : 404; res.end('fixture response') }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const get = axios.get.bind(axios)
axios.get = ((url: string, options: Record<string, unknown>) => {
  assert.ok(new URL(url).hostname.endsWith('.example.org'), 'the fixture is loopback-only')
  return get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { ...options, timeout: 40, proxy: false, headers: { ...(options.headers as object), 'x-fixture-url': url } })
}) as typeof axios.get
const run = async (path: string, agentId = 'a', sessionId = 'fetch-failures') => {
  const owner = makeOwnerKey({ workspace: process.cwd(), sessionId, lane: `agent:${agentId}` })
  return (await WebFetchTool.call({ url: path }, { owner, agentId, abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never)).data.result
}
let failures = 0
function check(label: string, ok: boolean, detail: string) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`); if (!ok) failures++ }
try {
  for (const [name, pattern] of [['reset', /connection reset/i], ['timeout', /timeout/i], ['406', /HTTP 406/], ['404', /HTTP 404/]] as const) {
    const text = await run(`https://${name}.example.org/${name}`)
    check(name, pattern.test(text) && /hosted reader not attempted:/i.test(text), text)
  }
  const before = requests
  const peer = await run('https://406.example.org/other', 'b')
  check('406 backs off a sibling without sending', requests === before && peer.includes('cooling down'), peer)
  const resetBefore = requests
  const resetPeer = await run('https://reset.example.org/other', 'b')
  check('reset backs off a sibling without sending', requests === resetBefore && resetPeer.includes('cooling down'), resetPeer)
  const separate = await run('https://406.example.org/404', 'c', 'separate-session')
  check('another session has its own pacing state', requests > resetBefore && separate.includes('HTTP 404'), separate)
  const robots = await run('https://robots-reset.example.org/page')
  check('unreachable robots fails closed with its reason', /robots.*connection reset/i.test(robots) && robots.includes('cannot verify robots.txt'), robots)
  const maps = await run('https://maps.example.org/maps')
  check('robots refusal names the absent maps road', maps.includes('robots.txt disallows') && maps.includes('no geocoding or routing road'), maps)
  const prompt = await WebFetchTool.prompt()
  check('description states robots and reader rules', prompt.includes('404 or 410') && prompt.includes('sparse successful HTML') && prompt.includes('shared by agents'), prompt.split('\n').filter(line => /robots|shared by agents/.test(line)).join(' '))
  const { networkFailureClass } = await import('../../src/tools/WebFetchTool/fetchErrors.ts')
  check('DNS and TLS classes survive nested errors', networkFailureClass({ cause: { code: 'ENOTFOUND' } }).includes('DNS failure') && networkFailureClass({ code: 'CERT_HAS_EXPIRED' }).includes('TLS failure'), 'typed cause codes')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { readFileSync } = await import('node:fs')
  const { WEB_CONTENT_NOTICE, shellWebContentNotice } = await import('../../src/tools/BashTool/webContent.ts')
  let appState = getDefaultAppState()
  const context = { options: { tools: [], commands: [], mcpClients: [], mcpResources: {} }, readFileState: new Map(), getAppState: () => appState, setAppState: (update: (s: typeof appState) => typeof appState) => { appState = update(appState) }, abortController: new AbortController(), toolUseId: 'web-content' } as never
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const route of ['/', '/large']) {
    const result = await BashTool.call({ command: `curl --noproxy '*' -sS -A 'Mozilla/5.0' ${local}${route}`, max_output_chars: 512 }, context)
    const block = BashTool.mapToolResultToToolResultBlockParam(result.data, 'web-content')
    check(`curl ${route} keeps the unverified marker`, result.data.stdout.includes(WEB_CONTENT_NOTICE) && String(block.content).includes(WEB_CONTENT_NOTICE), String(block.content).slice(0, 160))
    if (result.data.persistedOutputPath) check('spilled curl output keeps the marker', readFileSync(result.data.persistedOutputPath, 'utf8').startsWith(WEB_CONTENT_NOTICE), 'saved output header')
  }
  try { await BashTool.call({ command: `curl --noproxy '*' -sS --fail-with-body ${local}/curl-error` }, context); check('curl failure throws', false, 'unexpected success') } catch (error) {
    check('curl failure keeps the marker', String((error as { stderr: string }).stderr).includes(WEB_CONTENT_NOTICE), 'error output')
  }
  for (const options of [{ run_in_background: true }, { timeout: 1000 }]) {
    const result = await BashTool.call({ command: `curl --noproxy '*' -sSN ${local}/slow`, ...options }, context)
    check(`background curl ${JSON.stringify(options)} keeps the marker`, result.data.backgroundTaskId !== undefined && String(BashTool.mapToolResultToToolResultBlockParam(result.data, 'background-web').content).includes(WEB_CONTENT_NOTICE), result.data.stdout)
  }
  await new Promise(resolve => setTimeout(resolve, 2800))
  check('printed command text is not a web fetch', await shellWebContentNotice('echo "curl https://example.org"') === '', 'echo remains ordinary output')
  const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
  const bashPrompt = getSimplePrompt(new Set(['WebFetch', 'Browser', 'TaskStop', 'Service', 'ToolSearch']))
  check('Bash teaches the allowed honest-identification road', bashPrompt.includes('use WebFetch first') && bashPrompt.includes('identify Mercury honestly') && bashPrompt.includes('remain allowed'), 'model-facing prompt')
  console.log(`Bash prompt bytes: ${Buffer.byteLength(bashPrompt)}`)
} finally {
  axios.get = get
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
process.exitCode = failures ? 1 : 0
