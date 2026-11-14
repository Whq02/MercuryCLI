#!/usr/bin/env bun
import http from 'node:http'
import { check, detect, detectionHtml, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const accepted = `Basic ${Buffer.from('ada:first-req-pw').toString('base64')}`

interface Hit {
  tag: string
  method: string
  path: string
  rawHeaders: string[]
  body: string
}
const hits: Hit[] = []
let currentTag = 'setup'

const dead = http.createServer()
await new Promise<void>(r => dead.listen(0, '127.0.0.1', r))
const deadPort = (dead.address() as import('node:net').AddressInfo).port
await new Promise<void>(r => dead.close(() => r()))
const deadUrl = `http://127.0.0.1:${deadPort}/down`

const makeHandler = (otherOrigin: () => string) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const path = req.url ?? '/'
    if (path !== '/favicon.ico') {
      hits.push({ tag: currentTag, method: req.method ?? '', path, rawHeaders: [...req.rawHeaders], body })
    }
    if (path === '/private' && req.headers.authorization !== accepted) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="first-req"' })
      res.end('auth required')
      return
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/detect', 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (path === '/opener') {
      res.end(`<!doctype html><title>opener</title>
<a id="plain-get" href="/detect">plain-get</a>
<form id="plain-post-form" method="post" action="/detect"><input name="alpha" value="1"><input name="beta" value="two words"><button id="plain-post">plain-post</button></form>
<a id="plain-redir" href="/redirect">plain-redir</a>
<a id="plain-fail" href="${deadUrl}">plain-fail</a>
<a id="pop-link" target="_blank" href="/detect">pop-link</a>
<a id="pop-rel-noop" target="_blank" rel="noopener" href="/detect">pop-rel-noop</a>
<button id="pop-open" onclick="window.open('/detect', '_blank')">pop-open</button>
<button id="pop-win-noop" onclick="window.open('/detect', '_blank', 'noopener')">pop-win-noop</button>
<form id="pop-post-form" target="_blank" method="post" action="/detect"><input name="alpha" value="1"><input name="beta" value="two words"><button id="pop-post">pop-post</button></form>
<a id="pop-redir" target="_blank" href="/redirect">pop-redir</a>
<a id="pop-fail" target="_blank" href="${deadUrl}">pop-fail</a>
<a id="pop-auth" target="_blank" href="/private">pop-auth</a>
<a id="pop-cross-auth" target="_blank" href="${otherOrigin()}/private">pop-cross-auth</a>
<button id="pop-blank" onclick="const w = window.open('', '_blank'); w.document.body.innerHTML = '<p>blank</p>'">pop-blank</button>`)
      return
    }
    if (path === '/private') {
      res.end('<title>private</title><p id="ok">welcome ada</p>')
      return
    }
    res.end(detectionHtml(req.headers, tz))
  })
}

let bOrigin = ''
const A = await serve(0, makeHandler(() => bOrigin))
const B = await serve(0, makeHandler(() => A.origin))
bOrigin = B.origin

const pairsWithout = (raw: string[], omit: Set<string>): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i]!
    const v = raw[i + 1]!
    if (!omit.has(k.toLowerCase())) out.push([k, v])
  }
  return out
}

section('S1 plain main-tab reference requests')
await run({ op: 'open', url: `${A.origin}/opener` })
await pageOf().evaluate(() => { document.cookie = 'sid=first-req-cookie; path=/' })

currentTag = 'plain-get'
await run({ op: 'click', selector: '#plain-get' })
currentTag = 'reset'
await run({ op: 'open', url: `${A.origin}/opener` })

currentTag = 'plain-post'
await run({ op: 'click', selector: '#plain-post' })
currentTag = 'reset'
await run({ op: 'open', url: `${A.origin}/opener` })

currentTag = 'plain-redir'
await run({ op: 'click', selector: '#plain-redir' })
currentTag = 'reset'
await run({ op: 'open', url: `${A.origin}/opener` })

currentTag = 'plain-fail'
const plainFail = await run({ op: 'click', selector: '#plain-fail' })
const plainFailInfo = await run({ op: 'info' })
currentTag = 'reset'
await run({ op: 'open', url: `${A.origin}/opener` })

section('S2 named tabs and kept popups of every kind: raw headers, single send, and 9/9 stealth')
currentTag = 'named-beside'
await run({ op: 'open', tab: 'named-beside', url: `${A.origin}/detect` })
const nineBeside = await detect(lead, 'named-beside')
await run({ op: 'close', tab: 'named-beside' })

currentTag = 'named-own'
await run({ op: 'open', tab: 'named-own', url: `${B.origin}/detect` })
const nineOwn = await detect(lead, 'named-own')
await run({ op: 'close', tab: 'named-own' })

const plainGet = hits.find(h => h.tag === 'plain-get')!
const plainPost = hits.find(h => h.tag === 'plain-post')!
const plainRedir = hits.filter(h => h.tag === 'plain-redir')
const namedBeside = hits.find(h => h.tag === 'named-beside')!

check(
  'named tab first request carries the exact header set, order, and values as plain navigation (minus Referer/Sec-Fetch-Site)',
  hits.filter(h => h.tag === 'named-beside').length === 1 &&
    JSON.stringify(pairsWithout(namedBeside.rawHeaders, new Set(['referer', 'sec-fetch-site']))) ===
      JSON.stringify(pairsWithout(plainGet.rawHeaders, new Set(['referer', 'sec-fetch-site']))),
  JSON.stringify({ plain: plainGet.rawHeaders, named: namedBeside.rawHeaders }),
)
check('9/9 stealth holds on named tab beside main and on named tab in its own browser', nineBeside.passed === 9 && nineOwn.passed === 9)

for (const kind of ['pop-link', 'pop-rel-noop', 'pop-open', 'pop-win-noop', 'pop-post', 'pop-redir'] as const) {
  currentTag = kind
  const before = sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
  const act = await run({ op: 'click', selector: `#${kind}` })
  const tabName = sessions.browserTabs(ownerOf(lead)).find((s: { tab: string }) => !before.includes(s.tab))!.tab
  const nine = await detect(lead, tabName)
  const seenKind = hits.filter(h => h.tag === kind)
  if (kind === 'pop-link' || kind === 'pop-rel-noop' || kind === 'pop-open' || kind === 'pop-win-noop') {
    check(
      `${kind} sends 1 request with byte-for-byte identical raw headers and cookie as plain navigation`,
      seenKind.length === 1 && JSON.stringify(seenKind[0]!.rawHeaders) === JSON.stringify(plainGet.rawHeaders),
      JSON.stringify({ plain: plainGet.rawHeaders, got: seenKind[0]?.rawHeaders }),
    )
  } else if (kind === 'pop-post') {
    check(
      'posted form popup sends 1 POST with byte-for-byte identical raw headers, cookie, and body as plain form POST',
      seenKind.length === 1 &&
        seenKind[0]!.method === 'POST' &&
        seenKind[0]!.body === 'alpha=1&beta=two+words' &&
        seenKind[0]!.body === plainPost.body &&
        JSON.stringify(seenKind[0]!.rawHeaders) === JSON.stringify(plainPost.rawHeaders),
      JSON.stringify({ plain: plainPost, got: seenKind }),
    )
  } else if (kind === 'pop-redir') {
    check(
      'redirect popup sends exact same two-hop sequence and raw headers as plain redirect',
      seenKind.length === 2 &&
        plainRedir.length === 2 &&
        JSON.stringify(seenKind.map(h => [h.path, h.rawHeaders])) === JSON.stringify(plainRedir.map(h => [h.path, h.rawHeaders])),
      JSON.stringify({ plain: plainRedir, got: seenKind }),
    )
  }
  check(`9/9 stealth holds at first document of ${kind}`, act.outcome === 'succeeded' && nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  await run({ op: 'close', tab: tabName })
}

section('S3 failed load and 401 authentication challenge on a kept popup')
currentTag = 'pop-fail'
const beforeFail = sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
const popFailAct = await run({ op: 'click', selector: '#pop-fail' })
const failTab = sessions.browserTabs(ownerOf(lead)).find((s: { tab: string }) => !beforeFail.includes(s.tab))!.tab
const popFailInfo = await run({ op: 'info', tab: failTab })
const popFailRing = await run({ op: 'console', tab: failTab })
check(
  'failed load popup names net::ERR_CONNECTION_REFUSED and URL in act, info, and console ring just like a plain tab',
  plainFail.result.includes(`net::ERR_CONNECTION_REFUSED at ${deadUrl}`) &&
    plainFailInfo.result.includes(`net::ERR_CONNECTION_REFUSED at ${deadUrl}`) &&
    popFailAct.result.includes(`net::ERR_CONNECTION_REFUSED at ${deadUrl}`) &&
    popFailInfo.result.includes(`net::ERR_CONNECTION_REFUSED at ${deadUrl}`) &&
    popFailRing.result.includes(`GET ${deadUrl} FAILED net::ERR_CONNECTION_REFUSED (document)`),
  `${popFailAct.result} || ${popFailInfo.result} || ${popFailRing.result}`,
)
await run({ op: 'close', tab: failTab })

currentTag = 'pop-auth'
const beforeAuth = sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
const popAuthAct = await run({ op: 'click', selector: '#pop-auth' })
const authTab = sessions.browserTabs(ownerOf(lead)).find((s: { tab: string }) => !beforeAuth.includes(s.tab))!.tab
const authSet = await run({ op: 'viewport', tab: authTab, emulation: { credentials: { username: 'ada', password: 'first-req-pw' } } })
const authReload = await run({ op: 'reload', tab: authTab })
check(
  'same-origin 401 popup records failed target origin so credentials bind and reload recovers on the first try',
  popAuthAct.result.includes(`net::ERR_INVALID_AUTH_CREDENTIALS at ${A.origin}/private`) &&
    authSet.outcome === 'succeeded' &&
    authReload.outcome === 'succeeded' &&
    authReload.result.includes(`[200] — private`),
  `${popAuthAct.result} || ${authSet.result} || ${authReload.result}`,
)
await run({ op: 'close', tab: authTab })

await run({ op: 'close' })
await run({ op: 'open', url: `${A.origin}/opener` })
currentTag = 'pop-cross-auth'
const beforeCross = sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
await run({ op: 'click', selector: '#pop-cross-auth' })
const crossTab = sessions.browserTabs(ownerOf(lead)).find((s: { tab: string }) => !beforeCross.includes(s.tab))!.tab
const crossAsk = await permission({ op: 'viewport', tab: crossTab, emulation: { credentials: { username: 'ada', password: 'first-req-pw' } } })
check(
  'unapproved cross-origin 401 popup asks for that crossed-to origin when setting credentials on its error page',
  crossAsk.behavior === 'ask' &&
    crossAsk.message === `Browser viewport with basic credentials for ada on ${B.origin} in tab ${crossTab} — its address did not load, not yet approved this session`,
  JSON.stringify(crossAsk),
)
await run({ op: 'close', tab: crossTab })

section('S4 blank popup reset before its first navigation')
await run({ op: 'viewport', emulation: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' } })
const beforeBlank = sessions.browserTabs(ownerOf(lead)).map((s: { tab: string }) => s.tab)
await run({ op: 'click', selector: '#pop-blank' })
const blankTab = sessions.browserTabs(ownerOf(lead)).find((s: { tab: string }) => !beforeBlank.includes(s.tab))!.tab
await run({ op: 'viewport', tab: blankTab, emulation: { reset: true } })
const blankOpen = await run({ op: 'open', tab: blankTab, url: `${A.origin}/detect` })
const blankNine = await detect(lead, blankTab)
check(
  'blank popup reset to launch baseline before first navigation passes 9/9 stealth with desktop client hints',
  blankNine.passed === 9 && !blankOpen.result.includes('not armed'),
  `${blankOpen.result} || ${JSON.stringify(blankNine.checks)}`,
)

await finish('prove-browser-first-requests')
