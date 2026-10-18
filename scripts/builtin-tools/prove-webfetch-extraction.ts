import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { getURLMarkdownContent, clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.js')
const html = await Bun.file(new URL('./fixtures/webfetch/article.html', import.meta.url)).text()
const expected = (await Bun.file(new URL('./fixtures/webfetch/article.md', import.meta.url)).text()).trim()
const cases = await Bun.file(new URL('./fixtures/webfetch/cases.json', import.meta.url)).json() as { name: string; html: string; markdown: string }[]
const requests: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  requests.push(new URL(request.url).pathname)
  if (new URL(request.url).pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /')
  if (new URL(request.url).pathname === '/large') return new Response('0123456789'.repeat(11_200), { headers: { 'Content-Type': 'text/markdown' } })
  const fixture = cases.find(row => new URL(request.url).pathname === `/${row.name}`)
  return new Response(fixture?.html ?? html, { headers: { 'Content-Type': 'text/html' } })
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
  const context = { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never
  const large = await WebFetchTool.call({ url: 'https://fixture.example/large' } as never, context)
  if ('data' in large) {
    check('a large page has an honest size budget and token estimate', large.data.result.length < 40_000 && large.data.result.includes('38000 of 112000') && large.data.result.includes('9500 tokens'))
    const from = Number(/from: (\d+)/.exec(large.data.result)?.[1])
    const nextInput = WebFetchTool.inputSchema.safeParse({ url: 'https://fixture.example/large', from })
    check('the cut gives a valid continuation input', nextInput.success && from === 38_000)
    if (nextInput.success) {
      const next = await WebFetchTool.call(nextInput.data, context)
      check('the continuation starts at the exact next character without a new request', 'data' in next && next.data.result.includes('characters 38000–76000') && requests.filter(x => x === '/large').length === 1)
    }
  }
  for (const from of [-1, 1.5, Number.POSITIVE_INFINITY]) check(`invalid continuation ${from} is refused`, !WebFetchTool.inputSchema.safeParse({ url: 'https://fixture.example/large', from }).success)
  for (const fixture of cases) {
    const page = await getURLMarkdownContent(`https://fixture.example/${fixture.name}`, new AbortController())
    check(`stored extraction expectation: ${fixture.name}`, !('type' in page) && page.content === fixture.markdown, JSON.stringify(page))
  }
  const { pageSlice, MAX_FETCH_PAGE_CHARS } = await import('../../src/tools/WebFetchTool/pageBudget.js')
  for (const text of ['0123456789'.repeat(11_200), 'A'.repeat(MAX_FETCH_PAGE_CHARS - 1) + '🌍' + 'B'.repeat(50_000), ('paragraph words\n\n').repeat(4000)]) {
    let from = 0
    let rebuilt = ''
    do {
      const page = pageSlice(text, from)
      check('every slice advances within the ceiling and leaves the page text unchanged', page.end > from && page.text.length <= MAX_FETCH_PAGE_CHARS && page.text === text.slice(from, page.end))
      rebuilt += page.text
      from = page.end
    } while (from < text.length)
    check('all continuations reconstruct the complete page without loss or duplication', rebuilt === text)
  }
} finally {
  axios.get = get
  server.stop(true)
  clearWebFetchCache()
}
console.log(failures ? `WEBFETCH EXTRACTION RED: ${failures}` : 'WEBFETCH EXTRACTION GREEN')
process.exitCode = failures ? 1 : 0
