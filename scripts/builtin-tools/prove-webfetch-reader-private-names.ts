import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { readHostedPage } = await import('../../src/tools/WebFetchTool/reader.js')
const { FetchPacing } = await import('../../src/tools/WebFetchTool/fetchPacing.js')
const seen: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = request.headers.get('x-fixture-url')!
  seen.push(url)
  const target = url.startsWith('https://r.jina.ai/') ? url.slice('https://r.jina.ai/'.length) : url
  return Response.json({ data: { url: target, content: '# Rendered\n\nWords the reader returned.' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.equal(new URL(url).hostname, 'r.jina.ai', 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get
const priorFlag = process.env.MERCURY_FETCH_READER
let failures = 0
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
try {
  delete process.env.MERCURY_FETCH_READER
  const pace = new FetchPacing({ now: () => 0, random: () => 0.5, sleep: async () => {} })
  const privateNames = ['wiki.lan', 'jira.corp', 'nas.home', 'grafana.home.arpa', 'docs.intranet', 'board.private', 'ci.test', 'host.example', 'name.invalid', 'app.localhost', 'xyz.onion']
  for (const host of privateNames) {
    const before = seen.length
    const result = await readHostedPage(`https://${host}/dashboard?token=secret`, new AbortController().signal, pace)
    check(`a page on ${host} is never sent to the hosted reader (its words are the sparse page's own)`, seen.length === before && result.content === undefined && result.notice.includes('not sent to a hosted reader'))
  }
  const before = seen.length
  const open = await readHostedPage('https://news.example.org/story?id=1', new AbortController().signal, pace)
  check('a public host still reaches the reader', seen.length === before + 1 && open.content !== undefined)
} finally {
  axios.get = get
  if (priorFlag === undefined) delete process.env.MERCURY_FETCH_READER
  else process.env.MERCURY_FETCH_READER = priorFlag
  server.stop(true)
}
if (failures) { console.log(`FAIL ${failures} check(s): a private-network name reached r.jina.ai with its full URL`); process.exit(1) }
console.log('PASS webfetch reader private names: special-use and private-network host names never leave the box for the hosted reader')
