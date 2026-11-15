#!/usr/bin/env bun
import type http from 'node:http'
import { join } from 'node:path'
import type { Frame, Page } from 'puppeteer-core'
import { ROOT, check, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

let port = 0
const GAPS = [1, 1.5, 2, 2.5, 3, 4, 6, 40]
const LEAST = 16
const MOST = 160
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/hop') {
    res.end(`<!doctype html><title>hop</title><a id="go" href="http://localhost:${port}/leaf?hopped">go</a>`)
    return
  }
  if (url.pathname !== '/six') {
    res.end(`<!doctype html><title>leaf</title><p>leaf${url.search}</p>`)
    return
  }
  res.end(`<!doctype html><title>six</title><p>six</p>
<script>
  let at = performance.now()
  for (let n = 1; n <= 6; n++) {
    while (performance.now() < at) {}
    const frame = document.createElement('iframe')
    frame.src = 'http://localhost:${port}/leaf?n=' + n + '&load=${url.searchParams.get('load') ?? ''}'
    document.body.appendChild(frame)
    at = performance.now() + ${Number(url.searchParams.get('gap') ?? '2')}
  }
</script>`)
})
port = A.port

interface Sent {
  method: string
  params: { source?: string; filter?: unknown } | undefined
  session: string | undefined
}
const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
const sent: Sent[] = []
let birthWatch: 'whole' | 'refused' = 'whole'
let identity: 'whole' | 'throws' = 'whole'
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
  const command: Sent = { method: String(method), params: params as Sent['params'], session: typeof session === 'string' ? session : undefined }
  sent.push(command)
  if (birthWatch === 'refused' && command.method === 'Target.setAutoAttach' && JSON.stringify(command.params?.filter) === '[{"type":"page","exclude":false}]') return Promise.reject(new Error('the birth watch was refused'))
  if (identity === 'throws' && command.method === 'Emulation.setUserAgentOverride') throw new Error('the identity was made to throw')
  return send.call(this, callbacks, method, params, session, ...rest)
}

interface Wire {
  id(): string
  send(method: string, params?: unknown): Promise<{ result?: { value?: unknown } }>
}
interface Kit {
  cdp: Wire | null
  late?: unknown
  frames?: Map<string, { session: Wire; target: string }>
}
interface Reading {
  href: string
  runtime: string
  webdriver: boolean
  languages: string
  plugins: number
  toString: string
  runs: number
}
const READING = `JSON.stringify({ href: location.href, runtime: typeof (window.chrome && window.chrome.runtime), webdriver: navigator.webdriver, languages: navigator.languages.join(','), plugins: navigator.plugins.length, toString: Function.prototype.toString.toString(), runs: (() => { try { Function.prototype.toString.call(null) } catch (error) { return String(error.stack).split('\\n').slice(1).filter(line => line.includes('toString')).length - 1 } return -1 })() })`
const NATIVE = 'function toString() { [native code] }'
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const kitOf = (page: Page): Kit => sessions.pageKitOf(page)
const driverOf = (page: Page): string => (page as unknown as { _client(): { id(): string } })._client().id()
const readOn = async (wire: Wire | null): Promise<Reading | null> => {
  if (wire === null) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), 3000)
  })
  const answer = await Promise.race([wire.send('Runtime.evaluate', { expression: READING, returnByValue: true }).catch(() => null), late]).finally(() => clearTimeout(timer))
  const value = answer?.result?.value
  return typeof value === 'string' ? (JSON.parse(value) as Reading) : null
}
const prepared = (reading: Reading): boolean => reading.runtime === 'object' && reading.webdriver === false && reading.toString === NATIVE
const alike = (frame: Reading, top: Reading): boolean => prepared(frame) && frame.languages === top.languages && frame.plugins === top.plugins

interface Load {
  top: Reading | null
  frames: Array<{ reading: Reading | null; left: boolean }>
  whole: boolean
}
let loadCount = 0
const sixOn = async (page: Page, open: (url: string) => Promise<unknown>, gap: number): Promise<Load> => {
  const load = ++loadCount
  await open(`${A.origin}/six?gap=${gap}&load=${load}`)
  const kit = kitOf(page)
  for (let waited = 0; waited < 100 && (kit.frames?.size ?? 0) < 6; waited++) await nap(10)
  const left = new Set(
    page
      .frames()
      .filter((frame: Frame) => frame.parentFrame() !== null && (frame as unknown as { client: { id(): string } }).client.id() === driverOf(page))
      .map((frame: Frame) => String((frame as unknown as { _id?: string })._id)),
  )
  const top = await readOn(kit.cdp)
  const frames: Load['frames'] = []
  for (const held of [...(kit.frames?.values() ?? [])]) frames.push({ reading: await readOn(held.session), left: left.has(held.target) })
  const names = frames.map(frame => frame.reading?.href.split('/leaf?')[1] ?? '').sort()
  return { top, frames, whole: top !== null && names.join(' ') === [1, 2, 3, 4, 5, 6].map(n => `n=${n}&load=${load}`).join(' ') }
}

interface Tally {
  loads: Load[]
  struck: Load[]
  quiet: Load[]
}
const loadsOn = async (page: Page, open: (url: string) => Promise<unknown>): Promise<Tally> => {
  const tally: Tally = { loads: [], struck: [], quiet: [] }
  for (let trial = 0; trial < MOST && !(trial >= LEAST && tally.struck.length > 0 && tally.quiet.length > 0); trial++) {
    const load = await sixOn(page, open, GAPS[trial % GAPS.length]!)
    tally.loads.push(load)
    if (!load.whole) break
    if (load.frames.some(frame => frame.left)) tally.struck.push(load)
    else tally.quiet.push(load)
  }
  return tally
}
const words = (load: Load): string => `page ${load.top === null ? 'not read' : `ran ${load.top.runs}`}; frames ${load.frames.map(frame => (frame.reading === null ? 'not read' : `${frame.left ? 'LEFT ' : ''}ran ${frame.reading.runs} runtime ${frame.reading.runtime} webdriver ${frame.reading.webdriver} languages ${frame.reading.languages} plugins ${frame.reading.plugins}`)).join(' | ') || 'none held by the kit'}`
const kind = async (name: string, page: Page, open: (url: string) => Promise<unknown>): Promise<void> => {
  const tally = await loadsOn(page, open)
  const unread = tally.loads.find(load => !load.whole)
  const twice = tally.loads.find(load => load.top?.runs !== 1 || load.frames.some(frame => frame.reading?.runs !== 1))
  const odd = tally.loads.find(load => load.top === null || !prepared(load.top) || load.frames.some(frame => frame.reading === null || !alike(frame.reading, load.top!)))
  const left = tally.struck.flatMap(load => load.frames.filter(frame => frame.left))
  console.log(`    ${name}: ${tally.loads.length} loads read, ${tally.struck.length} in which the driver left a frame on the page’s session (${left.length} such frames), ${tally.quiet.length} quiet`)
  check(`${name}: in every load the page and each of its six frames, read through the kit’s own sessions, ran the script preparation exactly once`, unread === undefined && twice === undefined && tally.loads.length >= LEAST, `${tally.loads.length} loads; ${words((unread ?? twice ?? tally.loads[0])!)}`)
  check(`${name}: and every frame reads what its page reads: chrome.runtime, webdriver, languages, plugins, toString`, unread === undefined && odd === undefined, words((unread ?? odd ?? tally.loads[0])!))
  if (tally.struck.length === 0 && unread === undefined) {
    console.log(`  [SKIP] ${name}: a frame the driver left on the page’s session is prepared as its siblings — the driver left none there in ${tally.loads.length} loads on this machine, so that reading was not taken`)
    return
  }
  check(`${name}: a frame the driver left on the page’s session is prepared as its siblings`, unread === undefined && left.length > 0 && left.every(frame => frame.reading !== null && frame.reading.runs === 1 && prepared(frame.reading)), `${tally.struck.length} struck, ${tally.quiet.length} quiet; ${tally.struck[0] === undefined ? '' : words(tally.struck[0])}`)
}

section('S1 the launch’s page')
await run({ op: 'open', url: `${A.origin}/leaf?first` })
await kind('the launch’s page', pageOf(), url => run({ op: 'open', url }))

section('S2 a tab born beside it')
await run({ op: 'open', tab: 'beside', url: `${A.origin}/leaf?beside` })
await kind('a born tab', pageOf(lead, 'beside'), url => run({ op: 'open', tab: 'beside', url }))

section('S3 a late-armed page: the second tab of a launch whose birth watch the browser refused')
const lateOwner = { agentId: 'prepared-once-late' }
birthWatch = 'refused'
await run({ op: 'open', url: `${A.origin}/leaf?late` }, lateOwner)
birthWatch = 'whole'
await run({ op: 'open', tab: 'second', url: `${A.origin}/leaf?second` }, lateOwner)
await kind('a late-armed page', pageOf(lateOwner, 'second'), url => run({ op: 'open', tab: 'second', url }, lateOwner))
check('the tab beside is a born one and that second tab a late-armed one (holds on the parent too)', kitOf(pageOf(lead, 'beside')).late !== undefined && kitOf(pageOf(lateOwner, 'second')).late === undefined)

section('S4 who registers it')
const text = sent.find(command => command.method === 'Page.addScriptToEvaluateOnNewDocument' && command.session === kitOf(pageOf(lead, 'beside')).cdp?.id())?.params?.source ?? ''
const registered = (session: string | undefined): number => sent.filter(command => command.method === 'Page.addScriptToEvaluateOnNewDocument' && command.session === session && command.params?.source === text).length
{
  const pages: Array<[string, Page]> = [['launch', pageOf()], ['late-armed', pageOf(lateOwner, 'second')], ['born', pageOf(lead, 'beside')]]
  const counts = pages.map(([name, page]) => `${name}: own session ${registered(kitOf(page).cdp?.id())}, driver ${registered(driverOf(page))}`)
  check('where a launch asked for births the page’s own session registers the script preparation, once, and the driver registers none: the launch’s page, a late-armed page and a born tab alike', text !== '' && counts.every(count => count.endsWith('own session 1, driver 0')), counts.join(' ; '))
  const frameSessions = pages.flatMap(([, page]) => [...(kitOf(page).frames?.keys() ?? [])])
  const orders = frameSessions.map(id => sent.filter(command => command.session === id).map(command => (command.method === 'Page.addScriptToEvaluateOnNewDocument' ? (command.params?.source === text ? 'registered' : 'other text') : command.method === 'Runtime.runIfWaitingForDebugger' ? 'let go' : '')).filter(Boolean).join(','))
  check('and each frame session of those pages registers the same text once, before the frame is let go', frameSessions.length === 18 && orders.every(order => order === 'registered,let go'), `${frameSessions.length} frame sessions: ${[...new Set(orders)].join(' | ')}`)
}
const reference = { agentId: 'prepared-once-reference' }
{
  const mark = sent.length
  const bare = (await sessions.ensureBrowserSession(ownerOf(reference), { origin: A.origin, headless: true })) as { page: Page }
  await sessions.firstNavigation(bare, `${A.origin}/six?gap=40`, () => bare.page.goto(`${A.origin}/six?gap=40`, { waitUntil: 'load' }))
  const watches = sent.slice(mark).filter(command => command.method === 'Target.setAutoAttach' && JSON.stringify(command.params?.filter) === '[{"type":"iframe","exclude":false}]').length
  const top = await readOn(kitOf(bare.page).cdp)
  check(
    'a launch that asked for no births is not touched: the driver registers that same text there, the page’s own session none, no frame is watched, and its page ran it once (holds on the parent too)',
    registered(driverOf(bare.page)) === 1 && registered(kitOf(bare.page).cdp?.id()) === 0 && watches === 0 && top?.runs === 1 && (kitOf(bare.page).frames?.size ?? 0) === 0,
    `driver ${registered(driverOf(bare.page))}, own session ${registered(kitOf(bare.page).cdp?.id())}, frame watches ${watches}, page ran ${top?.runs}`,
  )
}

section('S5 the reading reads two where a document is prepared twice')
{
  await run({ op: 'open', tab: 'twice', url: `${A.origin}/leaf?twice` })
  const page = pageOf(lead, 'twice')
  await page.evaluateOnNewDocument(text)
  const loads: Load[] = []
  for (let trial = 0; trial < 8; trial++) loads.push(await sixOn(page, url => run({ op: 'open', tab: 'twice', url }), GAPS[trial % GAPS.length]!))
  const kept = loads.flatMap(load => load.frames.filter(frame => !frame.left))
  check(
    'on a born tab where this proof registers the same text again through the driver, the page reads two and so does every frame the driver holds on a session of its own (holds on the parent too)',
    loads.every(load => load.whole && load.top?.runs === 2) && kept.length > 0 && kept.every(frame => frame.reading?.runs === 2),
    loads.map(words).join(' || '),
  )
  await run({ op: 'close', tab: 'twice' })
}

section('S6 the preparation stays with a living page (holds on the parent too: these loads are quiet ones)')
{
  const page = pageOf()
  const stays = async (what: string, ready: boolean, detail: string): Promise<void> => {
    const now = pageOf()
    const kit = kitOf(now)
    for (let waited = 0; waited < 100 && (kit.frames?.size ?? 0) < 6; waited++) await nap(10)
    const top = await readOn(kit.cdp)
    const frames: Array<Reading | null> = []
    for (const held of [...(kit.frames?.values() ?? [])]) frames.push(await readOn(held.session))
    check(`${what} the launch’s page and its six frames ran it exactly once`, ready && top !== null && top.runs === 1 && prepared(top) && frames.length === 6 && frames.every(frame => frame !== null && frame.runs === 1 && prepared(frame)), `${detail} | page ${top === null ? 'not read' : `ran ${top.runs}`}; frames ${frames.map(frame => (frame === null ? 'not read' : `ran ${frame.runs} runtime ${frame.runtime}`)).join(' | ')}`)
  }
  identity = 'throws'
  const thrown = await run({ op: 'open', url: `${A.origin}/six?gap=40&load=thrown` })
  identity = 'whole'
  await stays('when the identity command of each frame throws', thrown.outcome === 'succeeded', thrown.result.split('\n')[0] ?? '')
  await run({ op: 'open', url: `${A.origin}/hop` })
  const hopped = await run({ op: 'click', selector: '#go' })
  const there = await readOn(kitOf(pageOf()).cdp)
  check('after a link takes the launch’s page to another site its document ran it exactly once', there !== null && there.href === `http://localhost:${port}/leaf?hopped` && there.runs === 1 && prepared(there), `${hopped.result.split('\n')[0] ?? ''} | ${there === null ? 'not read' : `${there.href} ran ${there.runs} runtime ${there.runtime}`}`)
  await run({ op: 'open', url: `${A.origin}/six?gap=40&load=stays` })
  const phone = await run({ op: 'viewport', emulation: { device: 'Pixel 5' } })
  await stays('after a device’s own reload', phone.result.includes('(the page was reloaded: mobile or touch changed)'), phone.result.split('\n')[0] ?? '')
  await run({ op: 'viewport', emulation: { reset: true } })
  const again = await run({ op: 'reload' })
  await stays('after a reset and a reload', again.outcome === 'succeeded', again.result.split('\n')[0] ?? '')
  void kitOf(page).cdp?.send('Page.navigate', { url: 'chrome://kill' }).catch(() => undefined)
  let crashed = false
  for (let waited = 0; waited < 50 && !crashed; waited++) {
    crashed = (sessions.activeSession(ownerOf(lead)) as { crashed?: boolean } | null)?.crashed === true
    if (!crashed) await nap(100)
  }
  const recovered = await run({ op: 'reload' })
  await stays('after a crash and its recovery', crashed && recovered.result.includes('this is a fresh load'), recovered.result.split('\n')[0] ?? '')
  await run({ op: 'close' })
  const started = await run({ op: 'open', url: `${A.origin}/six?gap=40&load=started` })
  await stays('after the browser is started again', started.outcome === 'succeeded', started.result.split('\n')[0] ?? '')
}

Connection.prototype._rawSend = send
await finish('prove-browser-prepared-once', [lead, lateOwner, reference])
