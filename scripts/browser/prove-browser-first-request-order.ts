#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { ROOT, check, finish, lead, ownerOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const tlsDir = mkdtempSync(join(tmpdir(), 'mercury-first-request-order-'))
const dropTls = (): void => {
  try {
    removeScratch(tlsDir, { maxRetries: 20, retryDelayMs: 150 })
  } catch {}
}
const minted = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-days', '2', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' })
if (minted.status !== 0 || !existsSync(join(tlsDir, 'cert.pem')) || !existsSync(join(tlsDir, 'key.pem'))) {
  const why = (minted.error?.message ?? minted.stderr ?? '').trim().split('\n').pop()?.slice(0, 160) ?? ''
  console.log(`  [SKIP] the order of a first request's headers — openssl minted no certificate here (${why || `exit ${minted.status}`}), and only a fixture the browser reaches through a tunnel reads that order under every runtime; prove-browser-first-requests.ts and prove-browser-popup-headers.ts read it where the runtime's own proxy keeps it`)
  dropTls()
  await finish('prove-browser-first-request-order')
}

interface Hit {
  tag: string
  method: string
  path: string
  raw: string[]
}
const hits: Hit[] = []
let tag = 'setup'
const dotted = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  if (path !== '/favicon.ico') hits.push({ tag, method: req.method ?? '', path, raw: [...req.rawHeaders] })
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>${path.slice(1) || 'root'}</title>`)
})
const dot = `http://localhost.:${dotted.port}`
const server = https.createServer({ key: readFileSync(join(tlsDir, 'key.pem')), cert: readFileSync(join(tlsDir, 'cert.pem')) }, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'https://fixture')
  const path = url.pathname
  req.resume()
  req.on('end', () => {
    if (path !== '/favicon.ico') hits.push({ tag, method: req.method ?? '', path, raw: [...req.rawHeaders] })
    if (path === '/hop') {
      res.writeHead(302, { location: '/landed', 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (path === '/pixel') {
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
      res.end(Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (path !== '/opener') {
      const name = path.slice(1) || 'root'
      res.end(`<!doctype html><title>${name}</title><img src="/pixel?from=${name}"><script>fetch('/api?from=${name}').catch(() => {})</script>`)
      return
    }
    res.end(`<!doctype html><title>opener</title>
<a id="plain" href="/plain">plain</a>
<form method="post" action="/plain-posted"><input name="alpha" value="1"><button id="plain-post">plain-post</button></form>
<a id="link" target="_blank" href="/link">link</a>
<a id="noopener" target="_blank" rel="noopener" href="/noopener">noopener</a>
<button id="winnoop" onclick="window.open('/winnoop', '_blank', 'noopener')">winnoop</button>
<button id="winopen" onclick="window.open('/winopen', '_blank')">winopen</button>
<form target="_blank" method="post" action="/posted"><input name="alpha" value="1"><button id="post">post</button></form>
<a id="hop" target="_blank" href="/hop">hop</a>
<button id="stray" onclick="const w = window.open('/first', '_blank'); w.location.href = 'http://untrusted.invalid/elsewhere'">stray</button>
<a id="dotplain" href="${dot}/dot-plain">dotplain</a>
<a id="dotpop" target="_blank" href="${dot}/dot-pop">dotpop</a>
<button id="straydot" onclick="const w = window.open('/first', '_blank'); w.location.href = '${dot}/stray-dot'">straydot</button>`)
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
const origin = `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`

interface Sent {
  tag: string
  method: string
  session: string
  id: string
  headers: string[] | null
}
interface Paused {
  tag: string
  id: string
  url: string
  headers: string[]
}
const sent: Sent[] = []
const paused: Paused[] = []
let alone = false
const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as {
  Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown; onMessage: (message: string) => unknown } }
}
const send = Connection.prototype._rawSend
const receive = Connection.prototype.onMessage
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, sessionId: unknown, ...rest: unknown[]) {
  let given = params
  if (method === 'Fetch.continueRequest') {
    const { requestId, headers } = params as { requestId: string; headers?: Array<{ name: string }> }
    sent.push({ tag, method, session: String(sessionId), id: requestId, headers: headers === undefined ? null : headers.map(entry => entry.name.toLowerCase()) })
    if (alone) given = { requestId }
  } else if (method === 'Network.setExtraHTTPHeaders') {
    const { headers } = params as { headers: Record<string, string> }
    sent.push({ tag, method, session: String(sessionId), id: '', headers: Object.keys(headers).map(name => name.toLowerCase()) })
    if (alone) given = { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith('sec-ch-ua'))) }
  }
  return send.call(this, callbacks, method, given, sessionId, ...rest)
}
Connection.prototype.onMessage = function (this: unknown, message: string) {
  if (message.includes('"Fetch.requestPaused"')) {
    const event = JSON.parse(message) as { params: { requestId: string; request: { url: string; headers: Record<string, string> } } }
    paused.push({ tag, id: event.params.requestId, url: event.params.request.url, headers: Object.keys(event.params.request.headers).map(name => name.toLowerCase()) })
  }
  return receive.call(this, message)
}

const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const of = (label: string, path: string): Hit[] => hits.filter(hit => hit.tag === label && hit.path === path)
const names = (hit: Hit | undefined): string => (hit?.raw ?? []).filter((_, index) => index % 2 === 0).map(name => name.toLowerCase()).join(',')
const values = (hit: Hit | undefined, name: string): string[] => (hit?.raw ?? []).filter((_, index, all) => index % 2 === 1 && all[index - 1]!.toLowerCase() === name)
const hints = (hit: Hit | undefined): string => JSON.stringify(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].map(name => values(hit, name)))
const pairs = (hit: Hit | undefined): string => JSON.stringify(hit?.raw ?? [])
const bag = (hit: Hit | undefined): string => JSON.stringify((hit?.raw ?? []).flatMap((name, index, all) => (index % 2 === 0 ? [`${name.toLowerCase()}: ${all[index + 1]}`] : [])).sort())
const tabs = (): string[] => sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
async function opened(label: string, selector: string): Promise<string> {
  tag = label
  const before = tabs()
  const act = await run({ op: 'click', selector })
  await nap(300)
  tag = 'between'
  const made = tabs().find(name => !before.includes(name))
  if (made !== undefined) await run({ op: 'close', tab: made })
  return act.result
}

section('S0 controls: a fixture the browser reaches through a tunnel, and a plain navigation (hold on the parent too)')
const refused = await run({ op: 'open', url: `${origin}/opener` })
const wide = await sessions.activeSession(ownerOf(lead)).browser.target().createCDPSession()
await wide.send('Security.setIgnoreCertificateErrors', { ignore: true })
const first = await run({ op: 'open', url: `${origin}/opener` })
check('the browser refuses the fixture’s certificate until this proof tells it otherwise', refused.result.includes('net::ERR_CERT_AUTHORITY_INVALID') && first.outcome === 'succeeded', `${refused.result} || ${first.result}`)
await sessions.activeSession(ownerOf(lead)).page.evaluate(() => {
  document.cookie = 'sid=first-request-order; path=/; secure'
})
tag = 'plain'
await run({ op: 'click', selector: '#plain' })
tag = 'between'
await run({ op: 'back' })
tag = 'plain-post'
await run({ op: 'click', selector: '#plain-post' })
tag = 'between'
await run({ op: 'open', url: `${origin}/opener` })
const plain = of('plain', '/plain')[0]
const plainPost = of('plain-post', '/plain-posted')[0]
const order = names(plain).split(',')
check(
  'the fixture reads the order the browser wrote: the brand list ahead of the user agent, Accept behind it, and the cookie last',
  order.indexOf('sec-ch-ua') !== -1 && order.indexOf('sec-ch-ua') < order.indexOf('user-agent') && order.indexOf('user-agent') < order.indexOf('accept') && order.at(-1) === 'cookie',
  names(plain),
)

const KINDS = [
  ['a target=_blank link', '#link', '/link'],
  ['a noopener link', '#noopener', '/noopener'],
  ['window.open with noopener', '#winnoop', '/winnoop'],
  ['a posted form', '#post', '/posted'],
  ['a redirect', '#hop', '/hop'],
] as const

section('S1 what the browser alone sends for a tab an act opens: the product’s two corrections withheld at the protocol')
alone = true
for (const [, selector, path] of KINDS) await opened(`alone:${path}`, selector)
await opened('alone:/winopen', '#winopen')
alone = false
check(
  'left alone, each such tab asks once, with a brand list that is not the presented identity’s',
  KINDS.every(([, , path]) => of(`alone:${path}`, path).length === 1 && hints(of(`alone:${path}`, path)[0]) !== hints(plain)),
  JSON.stringify(KINDS.map(([, , path]) => [path, of(`alone:${path}`, path).length, values(of(`alone:${path}`, path)[0], 'sec-ch-ua')])),
)

section('S2 the first request of a tab an act opens')
for (const [kind, selector, path] of KINDS) {
  const answer = await opened(`tab:${path}`, selector)
  const mine = of(`tab:${path}`, path)
  const theirs = of(`alone:${path}`, path)[0]
  check(`${kind}: the server is asked once, with the presented identity’s client hints`, mine.length === 1 && hints(mine[0]) === hints(plain), `${mine.length} ${hints(mine[0])} || ${hints(plain)} || ${answer}`)
  check(`${kind}: header for header in the order the browser alone gives that request`, names(mine[0]) === names(theirs), `tab: ${names(mine[0])} || alone: ${names(theirs)}`)
  check(`${kind}: the browser wrote that request itself, no header list was sent for it`, sent.filter(entry => entry.tag === `tab:${path}` && entry.method === 'Fetch.continueRequest' && entry.headers !== null).length === 0, JSON.stringify(sent.filter(entry => entry.tag === `tab:${path}`)))
  if (path === '/posted') check('a posted form: one POST, with the names and values a plain form post sends', mine[0]?.method === 'POST' && plainPost?.method === 'POST' && bag(mine[0]) === bag(plainPost), `tab: ${bag(mine[0])} || plain: ${bag(plainPost)}`)
  else if (path !== '/hop') check(`${kind}: name for name and value for value what a plain navigation sends`, pairs(mine[0]) === pairs(plain), `tab: ${pairs(mine[0])} || plain: ${pairs(plain)}`)
}
{
  await opened('tab:/winopen', '#winopen')
  const mine = of('tab:/winopen', '/winopen')
  check('window.open: the same order, with or without the corrections (holds on the parent too)', mine.length === 1 && names(mine[0]) === names(of('alone:/winopen', '/winopen')[0]) && names(mine[0]) === names(plain) && hints(mine[0]) === hints(plain), `tab: ${names(mine[0])} || alone: ${names(of('alone:/winopen', '/winopen')[0])}`)
}

section('S3 the three hints are set for that one request and taken back before it leaves')
{
  const mine = sent.filter(entry => entry.tag === 'tab:/link')
  const session = mine.find(entry => entry.method === 'Fetch.continueRequest')?.session
  const own = mine.filter(entry => entry.session === session)
  check(
    'a tab that carries no extra header: its client hints are set before its first request, and nothing is left set when that request is continued',
    JSON.stringify(own.map(entry => [entry.method, entry.headers])) === JSON.stringify([['Network.setExtraHTTPHeaders', ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']], ['Network.setExtraHTTPHeaders', []], ['Fetch.continueRequest', null]]),
    JSON.stringify(own),
  )
  const fetched = [of('tab:/link', '/pixel')[0], of('tab:/link', '/api')[0]]
  check('what that first document fetches carries each hint once, with the same values', fetched.every(hit => hit !== undefined && hints(hit) === hints(plain)), JSON.stringify(fetched.map(hit => hints(hit))))
}

section('S4 a tab that carries an extra header')
{
  const applied = await run({ op: 'viewport', emulation: { headers: { 'x-proof': 'one', 'a-first': 'two' } } })
  tag = 'extra:plain'
  await run({ op: 'click', selector: '#plain' })
  tag = 'between'
  await run({ op: 'back' })
  await opened('extra:/link', '#link')
  const mine = of('extra:/link', '/link')
  const theirs = of('extra:plain', '/plain')[0]
  check('a tab it opens sends both headers once, in the place its own navigation gives them', applied.outcome === 'succeeded' && mine.length === 1 && JSON.stringify([values(mine[0], 'x-proof'), values(mine[0], 'a-first')]) === '[["one"],["two"]]' && names(mine[0]) === names(theirs), `tab: ${names(mine[0])} || plain: ${names(theirs)}`)
  check('and the hints are taken back, the extra headers stay', JSON.stringify(sent.filter(entry => entry.tag === 'extra:/link' && entry.method === 'Network.setExtraHTTPHeaders').slice(0, 2).map(entry => entry.headers)) === JSON.stringify([['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'x-proof', 'a-first'], ['x-proof', 'a-first']]), JSON.stringify(sent.filter(entry => entry.tag === 'extra:/link')))
  await run({ op: 'viewport', emulation: { headers: null } })
}

section('S5 a window its opener sends elsewhere at once, to an address the browser sends no client hints')
{
  await opened('stray', '#stray')
  const asked = paused.filter(entry => entry.tag === 'stray' && entry.url.startsWith('http://untrusted.invalid/'))
  const continued = sent.filter(entry => entry.tag === 'stray' && entry.method === 'Fetch.continueRequest')
  const hinted = (list: string[]): boolean => list.some(name => name.startsWith('sec-ch-ua'))
  check(
    'no client hint goes out to it: its request carried none, or the request continued lists none',
    asked.length >= 1 && asked.every(entry => !hinted(entry.headers) || continued.some(reply => reply.id === entry.id && reply.headers !== null && !hinted(reply.headers))),
    JSON.stringify({ asked, continued }),
  )
}

section('S6 a loopback name written with its root dot, which the browser sends its client hints as it does localhost')
{
  const sentTo = async (label: string, selector: string, path: string): Promise<Hit[]> => {
    tag = label
    const before = tabs()
    await run({ op: 'click', selector })
    for (let waited = 0; waited < 50 && of(label, path).length === 0; waited++) await nap(100)
    await nap(200)
    tag = 'between'
    const made = tabs().find(name => !before.includes(name))
    if (made !== undefined) await run({ op: 'close', tab: made })
    return of(label, path)
  }
  const lists = (label: string): Sent[] => sent.filter(entry => entry.tag === label && entry.method === 'Fetch.continueRequest' && entry.headers !== null)
  tag = 'dot:plain'
  const went = await run({ op: 'click', selector: '#dotplain' })
  tag = 'between'
  await run({ op: 'back' })
  const there = of('dot:plain', '/dot-plain')[0]
  if (there === undefined) {
    console.log(`  [SKIP] a tab opened to ${dot} and a window sent there at once (five checks) — this machine did not reach the fixture under that name (${went.result.split('\n')[0]!.slice(0, 160)}), so the rows have nothing to read`)
  } else {
    check('a plain navigation there carries the three client hints, with the presented identity’s values (holds on the parent too)', hints(there) === hints(plain), `${hints(there)} || ${hints(plain)}`)
    const straight = await sentTo('dot:/dot-pop', '#dotpop', '/dot-pop')
    check('a tab opened straight to it: the server is asked once, with those hints (holds on the parent too)', straight.length === 1 && hints(straight[0]) === hints(plain), `${straight.length} ${hints(straight[0])} || ${hints(plain)}`)
    check('and the browser wrote that request itself, no header list was sent for it', lists('dot:/dot-pop').length === 0, JSON.stringify(sent.filter(entry => entry.tag === 'dot:/dot-pop')))
    const sentOn = await sentTo('dot:/stray-dot', '#straydot', '/stray-dot')
    check('a window its opener sends there at once keeps the three hints, with those values', sentOn.length === 1 && hints(sentOn[0]) === hints(plain), `${sentOn.length} ${hints(sentOn[0])} || ${hints(plain)}`)
    check('and no header list was sent for it either', lists('dot:/stray-dot').length === 0, JSON.stringify(sent.filter(entry => entry.tag === 'dot:/stray-dot')))
  }
}

Connection.prototype._rawSend = send
Connection.prototype.onMessage = receive
await wide.detach().catch(() => undefined)
await new Promise<void>(done => {
  server.closeAllConnections()
  server.close(() => done())
})
dropTls()
await finish('prove-browser-first-request-order')
