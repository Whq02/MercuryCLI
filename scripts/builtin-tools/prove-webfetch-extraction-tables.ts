import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.js')
const page = `<!doctype html><html><head><title>Precedence</title></head><body>
<nav><a href="/">Home</a><a href="/guide">Guide</a></nav>
<main><article>
<h1>Precedence</h1>
<p>When two settings disagree, the scheduler applies them in this order, and the order matters for every job that runs on this host.</p>
<table><thead><tr><th>Source</th><th>Wins over</th><th>Example</th></tr></thead>
<tbody><tr><td>Command line</td><td>Environment, file</td><td><code>--interval=10m</code></td></tr>
<tr><td>Environment</td><td>File</td><td><code>SCHED_INTERVAL=10m</code></td></tr>
<tr><td>File</td><td>Defaults</td><td><code>interval = "10m"</code></td></tr></tbody></table>
<p>A missing source falls through to the next row of the table above.</p>
</article></main>
<footer>Built with DocGen</footer>
</body></html>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.headers.get('x-fixture-url')!)
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /')
  return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.equal(new URL(url).hostname, 'fixture.example', 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get
try {
  clearWebFetchCache()
  const context = { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never
  const result = await WebFetchTool.call({ url: 'https://fixture.example/precedence' }, context)
  assert.ok('data' in result)
  const text = result.data.result
  const lines = text.split('\n')
  const row = lines.find(line => line.includes('Command line') && line.includes('Environment, file') && line.includes('--interval=10m'))
  assert.ok(row !== undefined, `a table row keeps its cells on one line so the columns survive; the page came back as:\n${text}`)
  const header = lines.find(line => line.includes('Source') && line.includes('Wins over') && line.includes('Example'))
  assert.ok(header !== undefined, 'the header row keeps its cells on one line')
  assert.ok(!text.includes('Built with DocGen') && !text.includes('Guide'), 'the chrome stays out')
  console.log('PASS webfetch extraction tables: a documentation table reaches the model with its rows and columns intact')
} finally {
  axios.get = get
  server.stop(true)
}
