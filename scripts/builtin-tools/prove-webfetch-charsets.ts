import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_FETCH_READER = '0'
const { getURLMarkdownContent, clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.ts')
const cases = [
  { name: 'latin', type: 'text/plain; charset=iso-8859-1', bytes: Buffer.from([99, 97, 102, 233]), expected: 'café' },
  { name: 'windows', type: 'text/plain; CHARSET = "windows-1252"', bytes: Buffer.from([128, 32, 147, 120, 148]), expected: '€ “x”' },
  { name: 'gbk', type: 'text/plain; charset=gbk', bytes: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), expected: '你好' },
  { name: 'gb18030', type: 'text/plain; charset=gb18030', bytes: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), expected: '你好' },
  { name: 'sjis', type: "text/plain; charset='shift_jis'", bytes: Buffer.from([0x93, 0xfa, 0x96, 0x7b]), expected: '日本' },
  { name: 'utf', type: 'text/plain', bytes: Buffer.from('café 世界'), expected: 'café 世界' },
  { name: 'html', type: 'text/html; charset=windows-1252', bytes: Buffer.concat([Buffer.from('<html><body><article><h1>caf'), Buffer.from([233]), Buffer.from('</h1><p>' + 'Article words. '.repeat(50) + '</p></article></body></html>')]), expected: 'café' },
]
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /')
  if (path === '/unsupported') return new Response('text', { headers: { 'Content-Type': 'text/plain; charset=not-a-charset' } })
  const row = cases.find(row => path === `/${row.name}`)!
  return new Response(row.bytes, { headers: { 'Content-Type': row.type } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: object) => {
  const parsed = new URL(url)
  assert.equal(parsed.hostname, 'fixture.example')
  return get(`http://127.0.0.1:${server.port}${parsed.pathname}`, { ...options, proxy: false })
}) as typeof axios.get
let failures = 0
try {
  for (const row of cases) {
    try {
      const answer = await getURLMarkdownContent(`https://fixture.example/${row.name}`, new AbortController())
      assert(!('type' in answer))
      assert(row.name === 'html' ? answer.content.includes(row.expected) : answer.content === row.expected, JSON.stringify(answer.content))
      assert.equal(answer.bytes, row.bytes.length)
      assert.deepEqual(await getURLMarkdownContent(`https://fixture.example/${row.name}`, new AbortController()), answer)
      console.log(`PASS ${row.name}`)
    } catch (error) { failures++; console.log(`FAIL ${row.name}: ${error}`) }
  }
  try {
    await assert.rejects(getURLMarkdownContent('https://fixture.example/unsupported', new AbortController()), /charset|encoding/i)
    console.log('PASS unsupported charset is not silently decoded as UTF-8')
  } catch (error) { failures++; console.log(`FAIL unsupported charset: ${error}`) }
} finally { axios.get = get; server.stop(true); clearWebFetchCache() }
process.exitCode = failures ? 1 : 0
