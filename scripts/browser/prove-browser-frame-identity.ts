#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import type http from 'node:http'
import { join } from 'node:path'
import type { Frame, Page } from 'puppeteer-core'
import { ROOT, check, detect, detectionHtml, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
let port = 0
interface Hit {
  path: string
  search: string
  host: string
  raw: string[]
}
const asked: Hit[] = []
const begun: string[] = []
const FIRST = `window.__first = { userAgent: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, languages: navigator.languages.join(','), brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand).join('+') : '', mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null, runtime: typeof (window.chrome && window.chrome.runtime), touch: navigator.maxTouchPoints }`
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  const path = url.pathname
  asked.push({ path, search: url.search, host: String(req.headers.host), raw: req.rawHeaders })
  const cross = `http://localhost:${port}`
  const script = (body: string): void => {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(body)
  }
  const html = (body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  if (path === '/worker.js') return script(`postMessage({ userAgent: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand).join('+') : '', languages: navigator.languages.join(',') })`)
  if (path === '/shared.js') return script('onconnect = event => event.ports[0].postMessage(navigator.userAgent)')
  if (path === '/sw.js') return script(`self.addEventListener('install', () => self.skipWaiting())`)
  if (path === '/detect') return html(detectionHtml(req.headers, hostTz))
  if (path === '/first' || path === '/slow') {
    const churned = url.searchParams.get('churn')
    if (churned !== null) {
      if (Number(churned) % 2 === 1) return
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.write('<!doctype html><title>first</title>')
      begun.push(churned)
      return
    }
    const nest = url.searchParams.has('nest') ? `<iframe src="http://127.0.0.1:${port}/first?who=nested" width="80" height="40"></iframe>` : ''
    const worker = url.searchParams.has('worker') ? `<script>new Worker('/worker.js').onmessage = event => { window.__worker = event.data }</script>` : ''
    const body = `<!doctype html><title>first</title><script>${FIRST}</script><a id="go" href="/first?who=clicked">go</a>${worker}${nest}`
    if (path === '/slow') setTimeout(() => html(body), 1500)
    else html(body)
    return
  }
  if (path === '/framed') {
    return html(`<!doctype html><title>framed</title><a id="pop" target="_blank" href="/framed?popup=1">pop</a>
<iframe src="${cross}/detect" width="320" height="120"></iframe>
<iframe src="/detect" width="320" height="120"></iframe>
<iframe src="${cross}/first?nest=1&worker=1" width="320" height="120"></iframe>`)
  }
  if (path === '/workers') {
    return html(`<!doctype html><title>workers</title><script>
window.__workers = {}
new Worker('/worker.js').onmessage = event => { window.__workers.dedicated = event.data.userAgent }
const shared = new SharedWorker('/shared.js')
shared.port.onmessage = event => { window.__workers.shared = event.data }
shared.port.start()
navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(registration => { window.__workers.service = registration.active ? 'active' : 'none' }, error => { window.__workers.service = 'error ' + error.message })
</script>`)
  }
  if (path === '/churn') {
    return html(`<!doctype html><title>churning</title><script>
const held = new Map()
let made = 0
let gone = 0
const drop = frame => {
  frame.remove()
  if (++gone === 20) setTimeout(() => { document.title = 'churned' }, 200)
}
window.__drop = list => {
  for (const mine of list) {
    const frame = held.get(mine)
    if (frame === undefined) continue
    held.delete(mine)
    drop(frame)
  }
}
const tick = () => {
  const frame = document.createElement('iframe')
  frame.src = '${cross}/first?churn=' + made
  document.body.appendChild(frame)
  if (made % 2) setTimeout(() => drop(frame), 0)
  else held.set(String(made), frame)
  if (++made < 20) setTimeout(tick, 10)
}
addEventListener('load', () => setTimeout(tick, 0))
</script>`)
  }
  if (path === '/holding') return html(`<!doctype html><title>holding</title><iframe src="${cross}/slow"></iframe>`)
  html('<!doctype html><title>plain</title><p>plain</p>')
})
port = A.port
const CROSS = `localhost:${port}`

interface Sent {
  method: string
  params: { filter?: unknown } | undefined
  session: string | undefined
}
const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
const sent: Sent[] = []
let arming: 'whole' | 'throws' | 'refused' | 'unanswered' = 'whole'
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
  sent.push({ method: String(method), params: params as Sent['params'], session: typeof session === 'string' ? session : undefined })
  if (method === 'Emulation.setUserAgentOverride' && arming !== 'whole') {
    if (arming === 'throws') throw new Error('the arming was made to throw')
    return arming === 'refused' ? Promise.reject(new Error('the arming was refused')) : new Promise(() => {})
  }
  return send.call(this, callbacks, method, params, session, ...rest)
}
const frameWatches = (from: number): Sent[] => sent.slice(from).filter(command => command.method === 'Target.setAutoAttach' && JSON.stringify(command.params?.filter) === '[{"type":"iframe","exclude":false}]')

interface First {
  userAgent: string
  appVersion: string
  platform: string
  languages: string
  brands: string
  mobile: boolean | null
  runtime: string
  touch: number
}
type Ctx = typeof lead
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const frameOf = (tab: string | undefined, part: string, page: Page = pageOf(lead, tab)): Frame | null => page.frames().find(frame => frame.parentFrame() !== null && frame.url().includes(part)) ?? null
const firstIn = async (tab: string | undefined, part: string, page?: Page): Promise<First | null> => {
  for (let waited = 0; waited < 30; waited++) {
    const frame = frameOf(tab, part, page)
    const got = frame === null ? null : ((await frame.evaluate(() => (window as unknown as { __first?: First }).__first ?? null).catch(() => null)) as First | null)
    if (got !== null) return got
    await nap(100)
  }
  return null
}
const nowIn = async (tab: string | undefined, part: string): Promise<First | null> => {
  const frame = frameOf(tab, part)
  if (frame === null) return null
  return (await frame.evaluate(`(() => { ${FIRST}; return window.__first })()`).catch(() => null)) as First | null
}
const topOf = async (tab?: string): Promise<First> => (await pageOf(lead, tab).evaluate(`(() => { ${FIRST}; return window.__first })()`)) as First
const nineIn = async (tab: string | undefined, part: string): Promise<{ passed: number; total: number; checks: Record<string, boolean> }> => {
  const live = sessions.activeSession(ownerOf(lead), tab)
  const frame = frameOf(tab, part)
  if (live === null || frame === null) return { passed: 0, total: 9, checks: {} }
  const flags: string[] = live.browser.process()?.spawnargs ?? []
  return (await frame.evaluate((spawnFlags: string[]) => (window as unknown as { __runDetection: (f: string[]) => Promise<unknown> }).__runDetection(spawnFlags), flags)) as { passed: number; total: number; checks: Record<string, boolean> }
}
const same = (first: First | null, top: First): boolean =>
  first !== null && first.userAgent === top.userAgent && first.appVersion === top.appVersion && first.platform === top.platform && first.languages === top.languages && first.brands === top.brands && first.mobile === top.mobile && first.runtime === 'object'
const surfaceOf = async (frame: Frame | null): Promise<string> =>
  frame === null
    ? 'no frame'
    : ((await frame.evaluate(() =>
        JSON.stringify([
          Object.getOwnPropertyNames(window).sort(),
          Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).sort(),
          typeof (window as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime,
          Function.prototype.toString.toString(),
        ]),
      )) as string)
const frameRequest = (from: number): string[] => asked.slice(from).find(hit => hit.path === '/detect' && hit.host === CROSS)?.raw ?? []
const IDENTITY_HEADERS = ['user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-language']
const identityOf = (raw: string[] | undefined): string => IDENTITY_HEADERS.map(name => `${name}: ${(raw ?? []).find((_, index, all) => index % 2 === 1 && all[index - 1]!.toLowerCase() === name) ?? '(absent)'}`).join(' | ')
const startedByFrame = async (tab: string | undefined, pagePath: string): Promise<{ frame: string; page: string }> => {
  const mark = asked.length
  const frame = frameOf(tab, `${CROSS}/first`)
  await frame?.evaluate(() => (document.getElementById('go') as HTMLAnchorElement).click()).catch(() => undefined)
  for (let waited = 0; waited < 30 && !asked.slice(mark).some(hit => hit.search === '?who=clicked'); waited++) await nap(100)
  return { frame: identityOf(asked.slice(mark).find(hit => hit.search === '?who=clicked')?.raw), page: identityOf([...asked].reverse().find(hit => hit.path === pagePath && hit.host !== CROSS)?.raw) }
}
const kitOf = (tab?: string): { cdp: { send: (method: string, params?: unknown) => Promise<unknown> } | null; frames?: Map<string, unknown> } => sessions.pageKitOf(pageOf(lead, tab))
const crash = async (tab?: string): Promise<boolean> => {
  void kitOf(tab).cdp?.send('Page.navigate', { url: 'chrome://kill' }).catch(() => undefined)
  for (let waited = 0; waited < 50; waited++) {
    if ((sessions.activeSession(ownerOf(lead), tab) as { crashed?: boolean } | null)?.crashed === true) return true
    await nap(100)
  }
  return false
}

section('S0 controls: the page itself and a frame of its own site (hold on the parent too)')
await run({ op: 'open', url: `${A.origin}/detect` })
const topNine = await detect()
check('the nine baseline assertions hold on the page', topNine.passed === 9 && topNine.total === 9, JSON.stringify(topNine.checks))
const mainMark = asked.length
const framed = await run({ op: 'open', url: `${A.origin}/framed` })
const host = await topOf()
{
  const nine = await nineIn(undefined, `127.0.0.1:${port}/detect`)
  check('and in a frame of the page’s own site', framed.outcome === 'succeeded' && nine.passed === 9 && nine.total === 9, `${framed.result} ${JSON.stringify(nine.checks)}`)
  check('the page presents a browser that is not headless, with its brands and two languages', !host.userAgent.includes('Headless') && host.brands.includes('Google Chrome') && host.languages.split(',').length >= 2, JSON.stringify(host))
}
const mainFrameRequest = frameRequest(mainMark)

section('S1 a frame from another site, on the page a launch starts with')
{
  const first = await firstIn(undefined, `${CROSS}/first`)
  check('at its first script it reads the identity its page presents: user agent, platform, brands, languages', same(first, host), JSON.stringify(first))
  const nine = await nineIn(undefined, `${CROSS}/detect`)
  check('[G5] the nine baseline assertions hold inside it (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  const nested = await firstIn(undefined, 'who=nested')
  check('a frame inside that frame reads it too', same(nested, host), JSON.stringify(nested))
  const frame = frameOf(undefined, `${CROSS}/first`)
  const workerOf = async (): Promise<{ userAgent: string; brands: string } | null> => {
    for (let waited = 0; waited < 30 && frame !== null; waited++) {
      const saw = (await frame.evaluate(() => (window as unknown as { __worker?: { userAgent: string; brands: string } }).__worker ?? null).catch(() => null)) as { userAgent: string; brands: string } | null
      if (saw !== null) return saw
      await nap(100)
    }
    return null
  }
  const worker = await workerOf()
  check('a worker that frame starts reads the user agent and the brands too', worker !== null && worker.userAgent === host.userAgent && worker.brands === host.brands, JSON.stringify(worker))
  const started = await startedByFrame(undefined, '/framed')
  check('a navigation that frame starts sends the identity its page sends: user agent, client hints, languages', started.frame === started.page && !started.frame.includes('Headless') && !started.frame.includes('(absent)'), `${started.frame} || ${started.page}`)
}

section('S2 on a tab born beside another')
await run({ op: 'open', tab: 'beside', url: `${A.origin}/framed` })
{
  const first = await firstIn('beside', `${CROSS}/first`)
  check('the frame reads the identity at its first script, and the page’s own script preparation has run in it', same(first, host), JSON.stringify(first))
  const nine = await nineIn('beside', `${CROSS}/detect`)
  check('[G5] the nine baseline assertions hold inside it (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  check('a frame inside that frame reads it too', same(await firstIn('beside', 'who=nested'), host))
}

section('S3 on a tab an act opened')
{
  const popped = await run({ op: 'click', tab: 'beside', selector: '#pop' })
  const name = /kept as tab (\S+) at/.exec(popped.result)?.[1] ?? ''
  const first = name === '' ? null : await firstIn(name, `${CROSS}/first`)
  check('the frame of the tab’s first document reads the identity at its first script', same(first, host), `${popped.result} ${JSON.stringify(first)}`)
  const nine = name === '' ? { passed: 0, total: 9, checks: {} } : await nineIn(name, `${CROSS}/detect`)
  check('[G5] the nine baseline assertions hold inside it (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  if (name !== '') await run({ op: 'close', tab: name })
}

section('S4 an emulated identity reaches the frame')
{
  const applied = await run({ op: 'viewport', tab: 'beside', emulation: { device: 'Pixel 5' } })
  const top = await topOf('beside')
  const first = await firstIn('beside', `${CROSS}/first`)
  check('[E6] after the device’s own reload the frame reads the phone at its first script: user agent, platform, client hints, touch', applied.result.includes('(the page was reloaded: mobile or touch changed)') && same(first, top) && /Android 11; Pixel 5/.test(first?.userAgent ?? '') && first?.platform === 'Linux armv81' && first.mobile === true && first.touch > 0, JSON.stringify(first))
  const nine = await nineIn('beside', `${CROSS}/detect`)
  check('[M13] the nine baseline assertions hold inside the frame of the emulated page (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  check('a frame inside that frame reads the phone too', same(await firstIn('beside', 'who=nested'), top))
  const phoned = await startedByFrame('beside', '/framed')
  check('[E6] a navigation that frame starts sends the phone’s identity', phoned.frame === phoned.page && phoned.frame.includes('Pixel 5') && phoned.frame.includes('sec-ch-ua-mobile: ?1'), `${phoned.frame} || ${phoned.page}`)
  const plain = await nowIn(undefined, `${CROSS}/first`)
  check('the frame of the same site on the other tab keeps its own page’s identity', plain !== null && plain.userAgent === host.userAgent && plain.platform === host.platform && plain.touch === 0, JSON.stringify(plain))
  const other = host.platform === 'Win32' ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
  await run({ op: 'viewport', tab: 'beside', emulation: { device: null, userAgent: other } })
  const live = await nowIn('beside', `${CROSS}/first`)
  const liveTop = await topOf('beside')
  check('[E6] an identity that needs no reload is read by the frame that is already there', live !== null && live.userAgent === other && live.platform === liveTop.platform && live.platform !== host.platform && live.touch === 0, JSON.stringify(live))
  await run({ op: 'viewport', tab: 'beside', emulation: { reset: true } })
  await run({ op: 'reload', tab: 'beside' })
  const back = await firstIn('beside', `${CROSS}/first`)
  check('[E2] after reset the frame reads the launch identity again', same(back, host) && back?.touch === 0, JSON.stringify(back))
  await run({ op: 'viewport', tab: 'beside', emulation: { timezone: hostTz === 'Asia/Tokyo' ? 'America/Lima' : 'Asia/Tokyo', locale: 'fr-FR' } })
  await run({ op: 'reload', tab: 'beside' })
  const sibling = frameOf(undefined, `${CROSS}/first`)
  const read = sibling === null ? null : ((await sibling.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Intl.NumberFormat().resolvedOptions().locale])) as string[])
  const mine = (await pageOf().evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Intl.NumberFormat().resolvedOptions().locale])) as string[]
  check('a zone and a locale asked on one tab do not enter the other tab’s frame of that site (holds on the parent too)', read !== null && read[0] === hostTz && read[1] === mine[1], JSON.stringify([read, mine]))
  await run({ op: 'viewport', tab: 'beside', emulation: { reset: true } })
  await run({ op: 'reload', tab: 'beside' })
}

section('S5 on a page after a recovery')
{
  const crashed = await crash('beside')
  const reloaded = await run({ op: 'reload', tab: 'beside' })
  const first = await firstIn('beside', `${CROSS}/first`)
  const nine = await nineIn('beside', `${CROSS}/detect`)
  check('[G5] the frame reads the identity and the nine hold inside it (9/9)', crashed && reloaded.result.includes('this is a fresh load') && same(first, host) && nine.passed === 9 && nine.total === 9, `${reloaded.result} ${JSON.stringify(first)} ${JSON.stringify(nine.checks)}`)
}

section('S6 a frame is always let go')
for (const kind of ['throws', 'refused', 'unanswered'] as const) {
  arming = kind
  const opened = await run({ op: 'open', url: `${A.origin}/framed?arming=${kind}` })
  const ran = await firstIn(undefined, `${CROSS}/first`)
  arming = 'whole'
  check(`an arming that ${kind === 'throws' ? 'throws' : kind === 'refused' ? 'the browser refuses' : 'is never answered'} still lets the frame run, and the page loads as it did`, opened.outcome === 'succeeded' && opened.ms < 15000 && ran !== null, `${opened.result} ${opened.ms}ms ${JSON.stringify(ran)}`)
}
{
  await run({ op: 'open', url: `${A.origin}/framed` })
  check('the next frames are armed again', same(await firstIn(undefined, `${CROSS}/first`), host))
  const handed: string[] = []
  const own = kitOf().cdp as unknown as { on: (event: string, listener: (event: { targetInfo: { type: string } }) => void) => void } | null
  own?.on('Target.attachedToTarget', event => handed.push(event.targetInfo.type))
  const opened = await run({ op: 'open', url: `${A.origin}/workers` })
  let workers: { dedicated?: string; shared?: string; service?: string } = {}
  for (let waited = 0; waited < 60; waited++) {
    workers = (await pageOf().evaluate(() => (window as unknown as { __workers: Record<string, string> }).__workers)) as typeof workers
    if (workers.dedicated !== undefined && workers.shared !== undefined && workers.service !== undefined) break
    await nap(100)
  }
  check('a page with a dedicated worker, a shared worker and a service worker runs all three (holds on the parent too)', opened.outcome === 'succeeded' && workers.dedicated === host.userAgent && typeof workers.shared === 'string' && workers.service === 'active', JSON.stringify(workers))
  check('and no worker is handed to the page’s session for frames (holds on the parent too)', handed.length === 0, handed.join(','))
  check('the page left behind leaves no frame session behind, a frame inside a frame included (holds on the parent too)', (kitOf().frames?.size ?? 0) === 0, String(kitOf().frames?.size))
  const churn = await run({ op: 'open', url: `${A.origin}/churn` })
  const dropped = new Set<string>()
  const handedFrames = (): number => handed.filter(type => type === 'iframe').length
  for (let waited = 0; waited < 160 && dropped.size < 10; waited++) {
    const loading = [...begun]
    const next = loading.filter(mine => !dropped.has(mine))
    if (next.length === 0 || handedFrames() < loading.length) {
      await nap(50)
      continue
    }
    await pageOf().evaluate((list: string[]) => (window as unknown as { __drop: (list: string[]) => void }).__drop(list), next)
    for (const mine of next) dropped.add(mine)
  }
  let title = ''
  for (let waited = 0; waited < 80 && title !== 'churned'; waited++) {
    title = await pageOf().title()
    if (title !== 'churned') await nap(100)
  }
  await nap(300)
  const after = await run({ op: 'open', url: `${A.origin}/` })
  check('twenty frames added and removed while they load leave nothing held and nothing kept', churn.outcome === 'succeeded' && title === 'churned' && after.outcome === 'succeeded' && after.ms < 5000 && handedFrames() >= 10 && (kitOf().frames?.size ?? 0) === 0, `${title} ${after.ms}ms handed ${handed.length} dropped ${dropped.size} kept ${kitOf().frames?.size}`)
  const opening = run({ op: 'open', tab: 'held', url: `${A.origin}/holding` })
  await nap(500)
  const closed = await run({ op: 'close', tab: 'held' })
  const settled = await opening
  check('a tab closed while its frame is still loading closes at once', closed.outcome === 'succeeded' && closed.ms < 5000 && settled.ms < 20000, `${closed.result} ${closed.ms}ms | ${settled.result} ${settled.ms}ms`)
}

section('S7 what a site sees')
const reference: Ctx = { agentId: 'frame-identity-reference' }
{
  const plainMark = sent.length
  const bare = (await sessions.ensureBrowserSession(ownerOf(reference), { origin: A.origin, headless: true })) as { page: Page }
  const referenceMark = asked.length
  await sessions.firstNavigation(bare, `${A.origin}/framed`, () => bare.page.goto(`${A.origin}/framed`, { waitUntil: 'load' }))
  const request = frameRequest(referenceMark)
  check('a launch that does not ask for it sends nothing for frames (the document printer’s road)', frameWatches(plainMark).length === 0, String(frameWatches(plainMark).length))
  check('the frame’s own request is header for header what that launch sends', mainFrameRequest.length > 0 && JSON.stringify(mainFrameRequest) === JSON.stringify(request), `${mainFrameRequest.join(' | ')} || ${request.join(' | ')}`)
  await run({ op: 'open', url: `${A.origin}/framed` })
  await run({ op: 'reload', tab: 'beside' })
  await firstIn(undefined, `${CROSS}/first`)
  await firstIn('beside', `${CROSS}/first`)
  const bareSurface = await surfaceOf(frameOf(undefined, `${CROSS}/first`, bare.page))
  check('a script in the frame finds the same names on its window and its navigator, and the same prepared surface, as in that launch', bareSurface !== 'no frame' && (await surfaceOf(frameOf(undefined, `${CROSS}/first`))) === bareSurface, bareSurface.slice(0, 200))
  check('and so it does on a tab born beside another', (await surfaceOf(frameOf('beside', `${CROSS}/first`))) === bareSurface)
}

section('S8 what it costs')
{
  const cold: Ctx = { agentId: 'frame-identity-cost' }
  const mark = sent.length
  await run({ op: 'open', url: `${A.origin}/` }, cold)
  const watches = frameWatches(mark)
  const coldKit = sessions.pageKitOf(pageOf(cold)) as { cdp: { id(): string }; frames?: Map<string, unknown> }
  check('a page with no frame from another site costs one command: the auto-attach on the page’s own session', watches.length === 1 && watches[0]?.session === coldKit.cdp.id() && (coldKit.frames?.size ?? 0) === 0, `${watches.length} ${coldKit.frames?.size}`)
  const perFrame = (tab: string | undefined): string[] => [...(kitOf(tab).frames?.keys() ?? [])].map(id => sent.filter(command => command.session === id).map(command => command.method).join(','))
  await run({ op: 'open', url: `${A.origin}/framed` })
  await firstIn(undefined, 'who=nested')
  const onLaunch = perFrame(undefined)
  check('a frame costs five commands on the launch’s page: the identity, the page’s script preparation registered on the frame’s own session with the page domain it needs, its own auto-attach and its release', onLaunch.length === 3 && onLaunch.every(list => list === 'Emulation.setUserAgentOverride,Page.enable,Page.addScriptToEvaluateOnNewDocument,Target.setAutoAttach,Runtime.runIfWaitingForDebugger'), onLaunch.join(' | '))
  await run({ op: 'open', tab: 'fresh', url: `${A.origin}/framed` })
  await firstIn('fresh', 'who=nested')
  const onBorn = perFrame('fresh')
  check('and the same five on a tab born beside it', onBorn.length === 3 && onBorn.every(list => list === 'Emulation.setUserAgentOverride,Page.enable,Page.addScriptToEvaluateOnNewDocument,Target.setAutoAttach,Runtime.runIfWaitingForDebugger'), onBorn.join(' | '))
  await sessions.disposeBrowserOwner(ownerOf(cold)).catch(() => undefined)
}

section('S9 the page')
{
  const page = readFileSync(join(ROOT, 'docs', 'BROWSER.md'), 'utf8')
  check(
    'the browser page says what a frame from another site reads and what stays the browser’s own',
    page.includes("A frame from another site reads that identity and its touch support too. Its time zone, locale, screen size and pixel ratio stay the browser's own: the browser keeps one zone and one locale for all frames of a site, in every tab, and applies a device's size to the page alone."),
  )
}

Connection.prototype._rawSend = send
await finish('prove-browser-frame-identity', [lead, reference])
