import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import { readFile, unlink } from 'node:fs/promises'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.js')
const seen: { url: string; ua: string | null }[] = []
const pdf = Buffer.from('%PDF-1.4\n\u0000\u0001encoded stream bytes\n%%EOF')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = request.headers.get('x-fixture-url')!
  seen.push({ url, ua: request.headers.get('user-agent') })
  const path = new URL(url).pathname
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /private\nDisallow: /redirect-denied\nAllow: /private/public\n')
  if (path === '/pay') return new Response('payment', { status: 402 })
  if (path === '/shape') return new Response('<div id="paywall">Subscribe to continue reading</div>', { headers: { 'Content-Type': 'text/html' } })
  if (path === '/pdf') return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } })
  if (path === '/rate') return new Response('wait', { status: 429, headers: { 'Retry-After': '120' } })
  if (path === '/forbidden') return new Response('forbidden', { status: 403 })
  if (path === '/redirect') return new Response('', { status: 302, headers: { Location: '/redirect-denied' } })
  if (path === '/cross') return new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/article' } })
  return new Response('<article><h1>Public reference</h1><p>A page discussing the phrase subscribe to continue reading is not itself a paywall.</p></article>', { headers: { 'Content-Type': 'text/html' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.ok(new URL(url).hostname.endsWith('.example'), 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get
let failures = 0
const check = (name: string, ok: boolean, text = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${text}`}`) }
const call = async (path: string, host = 'fixture.example') => {
  try {
    const result = await WebFetchTool.call({ url: `https://${host}${path}` }, { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never)
    return 'data' in result ? result.data.result : ''
  } catch (error) { return `THREW: ${error instanceof Error ? error.message : String(error)}` }
}
const files = new Set<string>()
try {
  clearWebFetchCache()
  check('HTTP 402 is a paywall with an alternative-source instruction', (await call('/pay')).includes('this page is paywalled; search for another source — do not retry this URL'))
  check('a visible paywall gate is named without a reading or reader', (await call('/shape')).includes('this page is paywalled'))
  check('a discussion of paywall words remains ordinary page text', (await call('/article')).includes('Public reference'))
  const document = await call('/pdf')
  const path = /saved to (.+?\.pdf)/.exec(document)?.[1]
  if (path) files.add(path)
  check('a PDF is named with its saved size, never decoded as page text', document.includes('PDF') && document.includes('text was not extracted') && document.includes(`${pdf.length} bytes`) && !document.includes('encoded stream bytes'), document)
  check('the PDF bytes are persisted unchanged', !!path && (await readFile(path)).equals(pdf))
  const before = seen.length
  const denied = await call('/private/article')
  check('robots disallow prevents the page request', denied.includes('robots.txt disallows') && !seen.slice(before).some(x => x.url.endsWith('/private/article')))
  check('a longer robots allow opens the public subpath', (await call('/private/public/article')).includes('Public reference'))
  const redirected = await call('/redirect')
  check('robots is checked again on a same-host redirect', redirected.includes('robots.txt disallows') && !seen.some(x => x.url.endsWith('/redirect-denied')))
  check('a cross-host redirect is returned, never fetched', (await call('/cross')).includes('CROSS-HOST REDIRECT') && !seen.some(x => x.url.startsWith('https://elsewhere.example')))
  check('every page and robots request identifies Mercury and its public contact', seen.every(x => x.ua?.startsWith('Mercury/') && x.ua.includes('https://github.com/Whq02/MercuryCLI/issues')))
  check('HTTP 403 says blocked and backed off, not only a status number', (await call('/forbidden', 'denied.example')).includes('backed off'))
  const rate = await call('/rate', 'rate.example')
  const count = seen.length
  const repeat = await call('/rate', 'rate.example')
  check('HTTP 429 honors the server wait and refuses a repeat without network', rate.includes('120s') && repeat.includes('cooling down') && seen.length === count)
  const { robotsAllows } = await import('../../src/tools/WebFetchTool/robots.js')
  for (const [rules, path, allowed] of [
    ['User-agent: *\nDisallow: /', '/a', false],
    ['User-agent: *\nDisallow: /\nUser-agent: Mercury\nAllow: /', '/a', true],
    ['User-agent: Mercury\nDisallow: /a\nUser-agent: Mercury\nDisallow: /b', '/b', false],
    ['User-agent: *\nDisallow: /*.pdf$', '/a.pdf?download=1', true],
    ['User-agent: *\nDisallow: /*.pdf$', '/a.pdf', false],
    ['User-agent: *\nDisallow: /a\nAllow: /a', '/a', true],
    ['User-agent: *\nDisallow: /~user', '/%7euser', false],
    ['User-agent: *\nDisallow: /a%2Fb', '/a/b', true],
    ['User-agent: *\nDisallow: /日本', '/%E6%97%A5%E6%9C%AC', false],
  ] as const) check(`robots matching ${path} -> ${allowed}`, robotsAllows(rules, `https://fixture.example${path}`) === allowed)
  const { pageAccessNotice } = await import('../../src/tools/WebFetchTool/pageAccess.js')
  check('structured article paywalls are recognized', !!pageAccessNotice('<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>'))
  check('a product price is not mistaken for a paywall', !pageAccessNotice('<script type="application/ld+json">{"@type":"Product","isAccessibleForFree":false}</script>'))
} finally {
  axios.get = get
  server.stop(true)
  clearWebFetchCache()
  for (const path of files) await unlink(path)
}
console.log(failures ? `WEBFETCH ACCESS RED: ${failures}` : 'WEBFETCH ACCESS GREEN')
process.exitCode = failures ? 1 : 0
