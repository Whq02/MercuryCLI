import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { getURLMarkdownContent, clearWebFetchCache, EgressBlockedError } = await import('../../src/tools/WebFetchTool/utils.js')
const seen: { url: string; headers: Headers }[] = []
const shell = '<html><body><div id="root">Loading page</div><script src="/app.js"></script></body></html>'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = request.headers.get('x-fixture-url')!
  seen.push({ url, headers: request.headers })
  if (url.includes('/robots.txt')) return new Response('User-agent: *\nAllow: /')
  if (url.includes('/blocked')) return new Response('blocked', { status: 403, headers: { 'x-proxy-error': 'blocked-by-allowlist' } })
  if (url.startsWith('https://r.jina.ai/')) {
    const target = url.slice('https://r.jina.ai/'.length)
    if (target.endsWith('/reader429')) return new Response('wait', { status: 429, headers: { 'retry-after': '120' } })
    return Response.json({ data: { url: target, content: '# Rendered article\n\nThe original browser-rendered words.' } })
  }
  return new Response(shell, { headers: { 'Content-Type': 'text/html' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.ok(['fixture.example.org', 'docs.python.org', 'r.jina.ai'].includes(new URL(url).hostname), 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get
let failures = 0
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
const context = { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never
const readerCount = () => seen.filter(x => x.url.startsWith('https://r.jina.ai/')).length
const priorFlag = process.env.MERCURY_FETCH_READER
try {
  delete process.env.MERCURY_FETCH_READER
  clearWebFetchCache()
  const result = await WebFetchTool.call({ url: 'https://fixture.example.org/spa' }, context)
  check('sparse page is rendered and names the hosted reader', 'data' in result && result.data.result.includes('read through r.jina.ai (the page needed a browser to render)') && result.data.result.includes('The original browser-rendered words.'))
  const request = seen.find(x => x.url.startsWith('https://r.jina.ai/'))
  check('the reader uses the browser engine and robots rule with no credentials', request?.headers.get('x-engine') === 'browser' && request.headers.get('x-robots-txt') === 'Mercury' && !request.headers.has('authorization') && !request.headers.has('cookie'))
  const before = readerCount()
  process.env.MERCURY_FETCH_READER = '0'
  const off = await WebFetchTool.call({ url: 'https://fixture.example.org/spa' }, context)
  check('turning the flag off returns sparse words even after a reader cache hit', 'data' in off && off.data.result.includes('hosted reader is off') && off.data.result.includes('Loading page') && !off.data.result.includes('Rendered article') && readerCount() === before)
  delete process.env.MERCURY_FETCH_READER
  const approved = await WebFetchTool.call({ url: 'https://docs.python.org/spa' }, context)
  check('preapproved documentation never reaches the reader', 'data' in approved && approved.data.result.includes('preapproved documentation is never sent') && readerCount() === before)
  let blocked = false
  try { await getURLMarkdownContent('https://fixture.example.org/blocked', new AbortController()) } catch (e) { blocked = e instanceof EgressBlockedError }
  check('an egress refusal is never bypassed by the hosted reader', blocked && readerCount() === before)
  const { FetchPacing } = await import('../../src/tools/WebFetchTool/fetchPacing.js')
  const { readHostedPage, READER_KEYLESS_RPM } = await import('../../src/tools/WebFetchTool/reader.js')
  let now = 0
  const pace = new FetchPacing({ now: () => now, random: () => 0.5, sleep: async ms => { now += ms } })
  const starts: number[] = []
  await Promise.all(Array.from({ length: 41 }, () => pace.run(60_000 / READER_KEYLESS_RPM, undefined, async wait => { assert.equal(wait, 0); starts.push(now) })))
  check('concurrent reader calls never exceed the official twenty-per-minute limit', starts.every((at, index) => index < 20 || at - starts[index - 20]! >= 60_000))
  const limited = await readHostedPage('https://fixture.example.org/reader429', new AbortController().signal, pace)
  const limitedCount = readerCount()
  const cooling = await readHostedPage('https://fixture.example.org/reader429', new AbortController().signal, pace)
  check('reader Retry-After is honored without another request', limited.notice.includes('120s') && cooling.notice.includes('cooling down for 120s') && readerCount() === limitedCount)
  now += 120_000
  check('the cooldown expires only after the server wait', pace.remaining() === 0)
  const ac = new AbortController(); ac.abort()
  await assert.rejects(() => pace.run(3000, ac.signal, async () => { throw new Error('request must not run') }), /aborted|abort/i)
  check('an aborted queued request is not sent', true)
  const description = await WebFetchTool.prompt({} as never)
  check('the tool describes direct egress, hosted rendering and its off switch', description.includes("leave the user's machine") && description.includes('hosted reader r.jina.ai') && description.includes('MERCURY_FETCH_READER=0'))
  check('the tool distinguishes page text from readings and names continuation', description.includes('Omit prompt') && description.includes('labelled reading') && description.includes('38,000') && description.includes('from offset'))
} finally {
  if (priorFlag === undefined) delete process.env.MERCURY_FETCH_READER
  else process.env.MERCURY_FETCH_READER = priorFlag
  axios.get = get
  server.stop(true)
  clearWebFetchCache()
}
console.log(failures ? `WEBFETCH READER RED: ${failures}` : 'WEBFETCH READER GREEN')
process.exitCode = failures ? 1 : 0
