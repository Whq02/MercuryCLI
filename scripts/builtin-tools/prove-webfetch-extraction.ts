import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { getURLMarkdownContent, clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.js')
const html = await Bun.file(new URL('./fixtures/webfetch/article.html', import.meta.url)).text()
const expected = (await Bun.file(new URL('./fixtures/webfetch/article.md', import.meta.url)).text()).trim()
const requests: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  requests.push(new URL(request.url).pathname)
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: object) => {
  const parsed = new URL(url)
  assert.equal(parsed.hostname, 'fixture.example', 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}${parsed.pathname}`, { ...options, proxy: false })
}) as typeof axios.get
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`)
}
try {
  clearWebFetchCache()
  const fetched = await getURLMarkdownContent('https://fixture.example/article', new AbortController())
  check('only the article words survive, with headings, lists, code and links', !('type' in fetched) && fetched.content === expected, JSON.stringify(fetched))
  const parsed = WebFetchTool.inputSchema.safeParse({ url: 'https://fixture.example/article' })
  check('a prompt is optional: default fetch needs no model', parsed.success)
  if (parsed.success) {
    const answer = await WebFetchTool.call(parsed.data, { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never)
    check('the default tool returns the page itself', 'data' in answer && answer.data.result.includes(expected))
  }
  check('the second fetch uses the page cache', requests.filter(x => x === '/article').length === 1)
} finally {
  axios.get = get
  server.stop(true)
  clearWebFetchCache()
}
console.log(failures ? `WEBFETCH EXTRACTION RED: ${failures}` : 'WEBFETCH EXTRACTION GREEN')
process.exitCode = failures ? 1 : 0
