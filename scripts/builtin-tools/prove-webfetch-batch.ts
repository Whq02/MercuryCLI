import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const seen: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = request.headers.get('x-fixture-url')!
  seen.push(url)
  if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /')
  if (url.endsWith('/missing')) return new Response('missing', { status: 404 })
  return new Response('صفحة '.repeat(15000), { headers: { 'content-type': 'text/plain' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.equal(new URL(url).hostname, 'batch.example.org')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get
const context = { owner: makeOwnerKey({ workspace: process.cwd(), sessionId: 'batch', lane: 'agent:a' }), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }), options: { isNonInteractiveSession: true } } as never
const urls = ['/one', '/missing', '/two'].map(path => `https://batch.example.org${path}`)
const permitted: string[] = []
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`); if (!ok) failures++ }
try {
  check('three-URL schema is offered', WebFetchTool.inputSchema.safeParse({ urls }).success)
  const result = await WebFetchTool.call({ urls } as never, context, (async (_tool, input) => { permitted.push(input.url as string); return { behavior: 'allow', updatedInput: input } }) as never, {} as never)
  const rows = (result.data as typeof result.data & { results?: Array<{ url: string; code: number; result: string }> }).results ?? []
  check('one call returns three ordered results', rows.length === 3 && rows.every((row, i) => row.url === urls[i]))
  check('one failed row retains its reason', rows[1]?.code === 404 && /HTTP 404/.test(rows[1]!.result) && /Hosted reader not attempted/.test(rows[1]!.result))
  check('each URL passed its own existing permission road', permitted.join() === urls.join())
  check('UTF-8 row and total byte budgets hold', rows.length === 3 && rows.every(row => Buffer.byteLength(row.result) <= 44000) && Buffer.byteLength(result.data.result) <= 132000, `${Buffer.byteLength(result.data.result)} bytes`)
  check('Unicode continuation remains explicit', rows[0]?.result.includes('from:') === true && !rows[0]?.result.includes('\ufffd'))
  const before = seen.length
  const denied = await WebFetchTool.call({ urls: ['https://batch.example.org/denied'] } as never, context, (async () => ({ behavior: 'deny', message: 'fixture refusal' })) as never, {} as never)
  check('a denied URL is not fetched', seen.length === before && denied.data.result.includes('fixture refusal'))
  check('mixed single/batch and oversized lists refuse', !WebFetchTool.inputSchema.safeParse({ url: urls[0], urls }).success && !WebFetchTool.inputSchema.safeParse({ urls: [...urls, urls[0]] }).success)
  const prompt = await WebFetchTool.prompt()
  check('description states batch byte budgets', prompt.includes('urls') && prompt.includes('132,000') && prompt.includes('38,000 bytes'))
} catch (error) {
  check('batch call completes', false, String(error))
} finally {
  axios.get = get
  server.stop(true)
}
process.exitCode = failures ? 1 : 0
