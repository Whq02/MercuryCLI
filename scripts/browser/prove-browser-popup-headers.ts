#!/usr/bin/env bun
import type http from 'node:http'
import { join } from 'node:path'
import { ROOT, check, detect, detectionHtml, finish, lead, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
interface Hit {
  path: string
  from: string | null
  method: string
  raw: string[]
}
const asked: Hit[] = []
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  const path = url.pathname
  asked.push({ path, from: url.searchParams.get('from'), method: req.method ?? '', raw: req.rawHeaders })
  if (path === '/hop') {
    res.writeHead(302, { location: '/landed' })
    res.end()
    return
  }
  if (path === '/file') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="held.bin"', 'content-length': '4' })
    res.end('abcd')
    return
  }
  if (path === '/pixel') {
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
    res.end(Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64'))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (path === '/detect') {
    res.end(detectionHtml(req.headers, hostTz))
    return
  }
  const name = path.slice(1) || 'root'
  res.end(`<!doctype html><title>${name}</title><img src="/pixel?from=${name}">
<script>fetch('/api?from=${name}').catch(() => {})${path === '/timer' ? `;setTimeout(() => window.open('/unasked', '_blank'), 600)` : ''}</script>
<a id="plain" href="/plain">plain</a>
<a id="blank" target="_blank" href="/blank">blank</a>
<a id="noopener" target="_blank" rel="noopener" href="/noopener">noopener</a>
<button id="winopen" onclick="window.open('/winopen', '_blank')">open</button>
<form target="_blank" method="post" action="/posted"><input name="a" value="1"><button id="post">post</button></form>
<a id="hop" target="_blank" href="/hop">hop</a>
<a id="file" target="_blank" href="/file">file</a>
<a id="detect" target="_blank" href="/detect">detect</a>`)
})

const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const of = (path: string, from?: string): Hit[] => asked.filter(hit => hit.path === path && (from === undefined || hit.from === from))
const names = (hit: Hit | undefined): string => (hit?.raw ?? []).filter((_, index) => index % 2 === 0).join(',')
const values = (hit: Hit | undefined, name: string): string[] => (hit?.raw ?? []).filter((_, index, all) => index % 2 === 1 && all[index - 1]!.toLowerCase() === name)
const keptName = (answer: { result: string }): string => /kept as tab (\S+) at/.exec(answer.result)?.[1] ?? ''

const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
const extraHeaderCommands: string[][] = []
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, ...rest: unknown[]) {
  if (method === 'Network.setExtraHTTPHeaders') extraHeaderCommands.push(Object.keys((params as { headers: Record<string, string> }).headers))
  return send.call(this, callbacks, method, params, ...rest)
}

section('S0 control: a tab that carries an extra header (holds on the parent too)')
await run({ op: 'open', tab: 'work', url: `${A.origin}/` })
const applied = await run({ op: 'viewport', tab: 'work', emulation: { headers: { 'x-proof': 'one' } } })
await run({ op: 'click', tab: 'work', selector: '#plain' })
const plain = of('/plain')[0]
await run({ op: 'back', tab: 'work' })
check('its own navigation carries the header once', applied.outcome === 'succeeded' && JSON.stringify(values(plain, 'x-proof')) === '["one"]', `${applied.result} ${names(plain)}`)

section('S1 the first request of a tab an act opens from it')
const kept: string[] = []
for (const [kind, selector, path] of [
  ['a target=_blank link', '#blank', '/blank'],
  ['a noopener link', '#noopener', '/noopener'],
  ['window.open', '#winopen', '/winopen'],
  ['a redirect', '#hop', '/hop'],
] as const) {
  const popped = await run({ op: 'click', tab: 'work', selector })
  const name = keptName(popped)
  kept.push(name)
  const first = of(path)
  check(`${kind}: the tab is kept and says the headers came with it`, name !== '' && popped.result.includes('the emulation came with it (headers)'), popped.result)
  check(`${kind}: its first request carries the header once, and the server is asked once`, first.length === 1 && JSON.stringify(values(first[0], 'x-proof')) === '["one"]', `${first.length} ${names(first[0])}`)
  check(`${kind}: header for header in the order of the opener’s own navigation`, names(first[0]) === names(plain), `the tab: ${names(first[0])} || its opener: ${names(plain)}`)
  if (path === '/hop') check('a redirect: the hop it lands on carries it too', of('/landed').length === 1 && JSON.stringify(values(of('/landed')[0], 'x-proof')) === '["one"]', names(of('/landed')[0]))
}
{
  const posted = await run({ op: 'click', tab: 'work', selector: '#post' })
  const name = keptName(posted)
  kept.push(name)
  const first = of('/posted')
  check('a posted form: one POST, with the header once', name !== '' && first.length === 1 && first[0]!.method === 'POST' && JSON.stringify(values(first[0], 'x-proof')) === '["one"]', `${posted.result} ${first.length} ${names(first[0])}`)
  await nap(400)
  const loaded = ['blank', 'noopener', 'winopen', 'landed', 'posted']
  check('what the first document itself fetches carries it: an image and a fetch of each', loaded.every(page => of('/pixel', page).length === 1 && values(of('/pixel', page)[0], 'x-proof').length === 1 && of('/api', page).length === 1 && values(of('/api', page)[0], 'x-proof').length === 1), JSON.stringify(loaded.map(page => [page, of('/pixel', page).map(hit => values(hit, 'x-proof')), of('/api', page).map(hit => values(hit, 'x-proof'))])))
}

section('S2 a new tab that turns out to be a download')
{
  const clicked = await run({ op: 'click', tab: 'work', selector: '#file' })
  const first = of('/file')
  check('the file’s request carries the header once', clicked.result.includes('note: the link is a download — saved to') && first.length === 1 && JSON.stringify(values(first[0], 'x-proof')) === '["one"]', `${clicked.result} ${names(first[0])}`)
}

section('S3 the kept tab afterwards: one copy, which follows the tab')
{
  const tab = kept[0] ?? ''
  await run({ op: 'open', tab, url: `${A.origin}/second` })
  check('its next navigation carries the header once', JSON.stringify(values(of('/second')[0], 'x-proof')) === '["one"]', names(of('/second')[0]))
  const replaced = await run({ op: 'viewport', tab, emulation: { headers: { 'x-proof': 'two' } } })
  await run({ op: 'open', tab, url: `${A.origin}/third` })
  check('replaced on that tab, the new value goes out alone', replaced.outcome === 'succeeded' && JSON.stringify(values(of('/third')[0], 'x-proof')) === '["two"]', JSON.stringify(values(of('/third')[0], 'x-proof')))
  const cleared = await run({ op: 'viewport', tab, emulation: { headers: null } })
  await run({ op: 'open', tab, url: `${A.origin}/fourth` })
  await nap(300)
  check('cleared on that tab, nothing of it goes out: the page, its image and its fetch', cleared.outcome === 'succeeded' && values(of('/fourth')[0], 'x-proof').length === 0 && values(of('/pixel', 'fourth')[0], 'x-proof').length === 0 && values(of('/api', 'fourth')[0], 'x-proof').length === 0 && of('/pixel', 'fourth').length === 1, names(of('/fourth')[0]))
  await run({ op: 'click', tab: 'work', selector: '#plain' })
  check('the opener keeps its own', JSON.stringify(values(of('/plain').at(-1), 'x-proof')) === '["one"]', names(of('/plain').at(-1)))
  await run({ op: 'back', tab: 'work' })
}

section('S4 the nine assertions on a tab born under extra headers')
{
  const popped = await run({ op: 'click', tab: 'work', selector: '#detect' })
  const name = keptName(popped)
  const nine = name === '' ? { passed: 0, total: 9, checks: {} } : await detect(lead, name)
  check('[G5] the nine baseline assertions hold on it (9/9; holds on the parent too)', nine.passed === 9 && nine.total === 9, `${popped.result} ${JSON.stringify(nine.checks)}`)
  check('and its first request carried the header', JSON.stringify(values(of('/detect')[0], 'x-proof')) === '["one"]', names(of('/detect')[0]))
}

section('S5 a tab no act opened')
{
  await run({ op: 'open', tab: 'work', url: `${A.origin}/timer` })
  await nap(1800)
  const ring = await run({ op: 'console', tab: 'work' })
  const first = of('/unasked')
  check('its one request carries the header as it carries the identity, and it is closed as before', first.length === 1 && JSON.stringify(values(first[0], 'x-proof')) === '["one"]' && ring.result.includes('closed unadopted (no act opened it'), `${first.length} ${names(first[0])} ${ring.result.split('\n').slice(-2).join(' | ')}`)
}

section('S6 a tab that carries no extra header')
{
  await run({ op: 'open', tab: 'bare', url: `${A.origin}/` })
  const before = extraHeaderCommands.length
  const popped = await run({ op: 'click', tab: 'bare', selector: '#blank' })
  const first = of('/blank').at(-1)
  const own = extraHeaderCommands.slice(before)
  check(
    'a tab it opens sends none, and the only commands about extra headers for it set its three client hints for its first request and take them back',
    keptName(popped) !== '' && values(first, 'x-proof').length === 0 && JSON.stringify(own) === JSON.stringify([['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'], []]),
    `${popped.result} ${JSON.stringify(own)}`,
  )
}

Connection.prototype._rawSend = send
await finish('prove-browser-popup-headers')
