#!/usr/bin/env bun
import type http from 'node:http'
import { join } from 'node:path'
import type { Browser, CDPSession, LaunchOptions } from 'puppeteer-core'
import { ROOT, check, detect, detectionHtml, finish, lead, ownerOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const asked: Array<{ path: string; raw: string[] }> = []
let held: http.ServerResponse | null = null
let arrived = (): void => {}
const files: string[] = []
let farMs = 0
const F = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  files.push(path)
  if (path === '/far') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>far</title><p>far</p>')
    }, farMs)
    return
  }
  res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"', 'cache-control': 'no-store' })
  res.end('a,b\n1,2\n')
})
const asksFor = (path: string): number => files.filter(seen => seen === path).length
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  asked.push({ path, raw: req.rawHeaders })
  if (path === '/held') {
    held = res
    arrived()
    return
  }
  if (path === '/moved-far') {
    res.writeHead(301, { location: `http://localhost:${F.port}/far`, 'cache-control': 'public, max-age=3600' })
    res.end()
    return
  }
  if (path === '/moved') {
    res.writeHead(301, { location: `http://localhost:${F.port}/report.csv`, 'cache-control': 'public, max-age=3600' })
    res.end()
    return
  }
  if (path === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>slow</title><p>slow</p>')
    }, 7000)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(path === '/detect' ? detectionHtml(req.headers, hostTz) : `<!doctype html><title>${path.slice(1)}</title><p>${path.slice(1)}</p>`)
})
const documents = (path: string): string[][] => asked.filter(hit => hit.path === path).map(hit => hit.raw)

type Ctx = typeof lead
const plain: Ctx = { agentId: 'first-navigation-plain' }
const aborted: Ctx = { agentId: 'first-navigation-aborted' }
const reached: Ctx = { agentId: 'first-navigation-reached' }
const twice: Ctx = { agentId: 'first-navigation-twice' }
const refused: Ctx = { agentId: 'first-navigation-refused' }
const quiet: Ctx = { agentId: 'first-navigation-quiet' }
const slow: Ctx = { agentId: 'first-navigation-slow' }
const halted: Ctx = { agentId: 'first-navigation-halted' }
const thrice: Ctx = { agentId: 'first-navigation-thrice' }
const stuck: Ctx = { agentId: 'first-navigation-stuck' }
const fourth: Ctx = { agentId: 'first-navigation-fourth' }
const kept: Ctx = { agentId: 'first-navigation-kept' }
const fetched: Ctx = { agentId: 'first-navigation-fetched' }

const { default: driver } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'))) as { default: { launch: (options: LaunchOptions) => Promise<Browser> } }
let unsent = 0
let silent: { url: string; from: number | null; left?: number; within?: number; held?: () => void } | null = null
let launchedAt = 0
let attempts = 0
const paused: Array<{ url: string; at: number }> = []
const startsOf = (url: string, since = 0): Array<{ url: string; at: number }> => paused.filter(seen => seen.url === url && seen.at >= since)
let watcher: CDPSession | null = null
sessions.setBrowserLaunchDriverForProof(async (options: LaunchOptions): Promise<Browser> => {
  const browser = await driver.launch(options)
  const [page] = await browser.pages()
  const cdp = await page!.createCDPSession()
  watcher = cdp
  cdp.on('Fetch.requestPaused', event => {
    if (event.resourceType === 'Document') {
      attempts++
      paused.push({ url: event.request.url, at: Date.now() })
    }
    if (event.resourceType === 'Document' && silent !== null && event.request.url === silent.url && Date.now() - (silent.from ?? launchedAt) <= (silent.within ?? 4000)) {
      silent.held?.()
      silent.left = (silent.left ?? 1) - 1
      if (silent.left <= 0) silent = null
      return
    }
    if (unsent > 0 && event.resourceType === 'Document') {
      unsent--
      void cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined)
      return
    }
    void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined)
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  launchedAt = Date.now()
  return browser
})
const ringOf = async (ctx: Ctx): Promise<string> => (await run({ op: 'console' }, ctx)).result
const ABORTED = (path: string): string => `open failed: net::ERR_ABORTED at ${A.origin}${path}`
const selfDropped = (url: string, began: number): boolean => {
  const mine = startsOf(url, began)
  return process.platform === 'win32' && (mine[0] === undefined || mine[0].at - Math.max(began, launchedAt) >= 4500)
}
const notStaged = (what: string): void => console.log(`  [SKIP] ${what}: this launch's browser dropped starts of its first navigation by itself (the first one the fixture saw came five seconds late or none came), so the starts that were left went to the fixture's own drops`)

section('S0 control: the first navigation of a launch that nothing aborts (holds on the parent too)')
{
  attempts = 0
  const opened = await run({ op: 'open', url: `${A.origin}/detect` }, plain)
  const nine = opened.outcome === 'succeeded' ? await detect(plain) : { passed: 0, total: 9, checks: {} }
  check('an ordinary first open answers with the page', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/detect [200] — `), opened.result)
  check('one navigation was started and the server was asked once', attempts === 1 && documents('/detect').length === 1, `${attempts} | ${documents('/detect').length}`)
  check('the nine baseline assertions hold on it', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
}

section('S1 the first navigation of a launch, aborted before its request left, is started once more')
{
  attempts = 0
  unsent = 1
  const before = documents('/detect').length
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/detect` }, aborted)
  unsent = 0
  if (opened.outcome !== 'succeeded' && selfDropped(`${A.origin}/detect`, began)) notStaged('S1')
  else {
    const nine = opened.outcome === 'succeeded' ? await detect(aborted) : { passed: 0, total: 9, checks: {} }
    const reference = documents('/detect')[0] ?? []
    const sent = documents('/detect')[before] ?? []
    check('the open answers with the page, in the words of an ordinary open', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/detect [200] — `) && !opened.result.includes('ERR_ABORTED'), opened.result)
    check('the navigation was started twice and the server was asked once', attempts === 2 && documents('/detect').length === before + 1, `${attempts} | ${documents('/detect').length - before}`)
    check('what the site was sent is, header for header, what an unaborted first open sends', sent.length > 0 && JSON.stringify(sent) === JSON.stringify(reference), `${sent.join(' | ')} || ${reference.join(' | ')}`)
    check('the nine baseline assertions hold on the page it reached', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
    const ring = await ringOf(aborted)
    check('the ring keeps what happened: the aborted request, then the page', ring.includes(`net: GET ${A.origin}/detect FAILED net::ERR_ABORTED (document)`) && ring.includes(`nav: navigated to ${A.origin}/detect`), ring)
  }
}

section('S2 a later navigation of that browser, aborted the same way, is not started again')
{
  attempts = 0
  unsent = 1
  const later = await run({ op: 'open', url: `${A.origin}/later` }, aborted)
  check('it fails in the words it always had', later.outcome === 'failed' && later.result === ABORTED('/later'), later.result)
  check('one navigation was started and nothing reached the server', attempts === 1 && documents('/later').length === 0, `${attempts} | ${documents('/later').length}`)
  const again = await run({ op: 'open', url: `${A.origin}/later` }, aborted)
  check('the same open again loads the page, as before', again.outcome === 'succeeded' && again.result.startsWith(`open: ${A.origin}/later [200] — later`), again.result)
}

section('S3 a first navigation aborted after its request reached the server is not started again')
{
  attempts = 0
  unsent = 0
  const reachedServer = new Promise<void>(resolve => {
    arrived = resolve
  })
  const opening = run({ op: 'open', url: `${A.origin}/held` }, reached)
  await Promise.race([reachedServer, new Promise(resolve => setTimeout(resolve, 20000))])
  await (watcher as CDPSession | null)?.send('Page.navigate', { url: 'about:blank' })
  const opened = await opening
  ;(held as http.ServerResponse | null)?.destroy()
  check('it fails in the words it always had', opened.outcome === 'failed' && opened.result === ABORTED('/held'), opened.result)
  check('one navigation was started and the server was asked once, not twice', attempts === 1 && documents('/held').length === 1, `${attempts} | ${documents('/held').length}`)
}

section('S4 a first navigation aborted twice before a request left is started a third time, five seconds on')
{
  attempts = 0
  unsent = 2
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/twice` }, twice)
  const took = Date.now() - began
  unsent = 0
  if (opened.outcome !== 'succeeded' && selfDropped(`${A.origin}/twice`, began)) notStaged('S4')
  else {
    check('the open answers with the page', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/twice [200] — twice`), opened.result)
    check('the navigation was started three times and the server was asked once', attempts === 3 && documents('/twice').length === 1, `${attempts} | ${documents('/twice').length}`)
    check('the third start waited five seconds after the second', took >= 4500, `${took} ms`)
  }
}

section('S5 a first navigation that fails another way is not started again')
{
  attempts = 0
  const opened = await run({ op: 'open', url: 'http://127.0.0.1:27299/' }, refused)
  check('a refused connection is named once, as before', opened.outcome === 'failed' && opened.result.includes('net::ERR_CONNECTION_REFUSED') && attempts === 1, `${opened.result} ${attempts}`)
}

section('S6 a first navigation that neither fails nor sends its request is started once more')
{
  const address = `${A.origin}/detect`
  const before = documents('/detect').length
  const began = Date.now()
  silent = { url: address, from: null }
  const opened = await run({ op: 'open', url: address, timeoutMs: 20000 }, quiet)
  const took = Date.now() - began
  silent = null
  const mine = startsOf(address, began)
  const alone = process.platform === 'win32' && mine.length === 1 && mine[0]!.at - launchedAt >= 4500
  const nine = opened.outcome === 'succeeded' ? await detect(quiet) : { passed: 0, total: 9, checks: {} }
  const reference = documents('/detect')[0] ?? []
  const sent = documents('/detect')[before] ?? []
  check('the open answers with the page, in the words of an ordinary open', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/detect [200] — `), opened.result)
  if (alone) console.log("  [SKIP] S6, the count of its starts: this launch's browser dropped its first navigation by itself, so the fixture held nothing and the one start seen is the one more start, five seconds late")
  else check('the navigation was started twice, the second after five seconds of silence', mine.length === 2 && mine[1]!.at - mine[0]!.at >= 4500 && mine[1]!.at - mine[0]!.at < 9000, `${mine.length} | ${mine.map(seen => seen.at - began).join(',')} | ${took} ms`)
  check('the server was asked once', documents('/detect').length === before + 1, String(documents('/detect').length - before))
  check('what the site was sent is, header for header, what an unaborted first open sends', sent.length > 0 && JSON.stringify(sent) === JSON.stringify(reference), `${sent.join(' | ')} || ${reference.join(' | ')}`)
  check('the nine baseline assertions hold on the page it reached', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
}

section('S7 a slow first navigation whose request has left is not started again')
{
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/slow` }, slow)
  const took = Date.now() - began
  check('the open answers with the page when the server does', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/slow [200] — slow`) && took >= 6500, `${opened.result} | ${took} ms`)
  check('one navigation was started and the server was asked once', startsOf(`${A.origin}/slow`, began).length === 1 && documents('/slow').length === 1, `${startsOf(`${A.origin}/slow`, began).length} | ${documents('/slow').length}`)
}

section('S8 a later navigation of that browser that goes silent is not started again')
{
  const address = `${A.origin}/later-quiet`
  const began = Date.now()
  silent = { url: address, from: began }
  const later = await run({ op: 'open', url: address, timeoutMs: 7000 }, quiet)
  silent = null
  check('it waits out its own time and fails in the words it always had', later.outcome === 'failed' && later.result.includes('Navigation timeout of 7000 ms exceeded'), later.result)
  check('one navigation was started and nothing reached the server', startsOf(address, began).length === 1 && documents('/later-quiet').length === 0, `${startsOf(address, began).length} | ${documents('/later-quiet').length}`)
}

section('S9 an interrupt during the silence starts nothing more')
{
  const address = `${A.origin}/halted`
  const stop = new AbortController()
  let press: ReturnType<typeof setTimeout> | undefined
  const began = Date.now()
  silent = { url: address, from: null, held: () => { press = setTimeout(() => stop.abort(new DOMException('The operation was aborted.', 'AbortError')), 800) } }
  const opened = await run({ op: 'open', url: address, timeoutMs: 7000 }, { ...halted, abortController: stop } as Ctx)
  clearTimeout(press)
  silent = null
  const mine = startsOf(address, began)
  if (process.platform === 'win32' && press === undefined && mine.length === 1 && mine[0]!.at - launchedAt >= 4500) console.log("  [SKIP] S9: this launch's browser dropped its first navigation by itself, so the fixture held nothing and no interrupt was sent")
  else {
    check('the navigation was held and the interrupt came during the silence', press !== undefined && stop.signal.aborted, `${press !== undefined} | ${stop.signal.aborted}`)
    check('the open does not answer with the page', opened.outcome !== 'succeeded', `${opened.outcome} | ${opened.result}`)
    check('no navigation was started after the interrupt, nothing reached the server and the origin was not approved', mine.length === 1 && documents('/halted').length === 0 && sessions.originApproved(ownerOf(halted), A.origin) === false, `${mine.length} | ${documents('/halted').length} | ${sessions.originApproved(ownerOf(halted), A.origin)}`)
  }
}

section('S10 a first navigation that goes silent twice is started a third time')
{
  const address = `${A.origin}/silent-twice`
  const began = Date.now()
  silent = { url: address, from: null, left: 2, within: 7500 }
  const opened = await run({ op: 'open', url: address, timeoutMs: 20000 }, thrice)
  const took = Date.now() - began
  silent = null
  const mine = startsOf(address, began)
  check('the open answers with the page', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${address} [200] — silent-twice`), opened.result)
  if (selfDropped(address, began)) console.log("  [SKIP] S10, the count of its starts: this launch's browser dropped its first navigation by itself, so the fixture held one start fewer")
  else check('the navigation was started three times, each five seconds after the one before', mine.length === 3 && mine[1]!.at - mine[0]!.at >= 4500 && mine[1]!.at - mine[0]!.at < 9000 && mine[2]!.at - mine[1]!.at >= 4500 && mine[2]!.at - mine[1]!.at < 9000, `${mine.length} | ${mine.map(seen => seen.at - began).join(',')} | ${took} ms`)
  check('the server was asked once', documents('/silent-twice').length === 1, String(documents('/silent-twice').length))
}

section('S11 a first navigation that never leaves is started four times and no more')
{
  const address = `${A.origin}/never`
  const began = Date.now()
  silent = { url: address, from: null, left: 99, within: 120000 }
  const opened = await run({ op: 'open', url: address, timeoutMs: 7000 }, stuck)
  const took = Date.now() - began
  silent = null
  const mine = startsOf(address, began)
  check('it waits out its own time on the last start and fails in the words it always had', opened.outcome === 'failed' && opened.result.includes('Navigation timeout of 7000 ms exceeded'), opened.result)
  check('four navigations were started and no more, and nothing reached the server', (selfDropped(address, began) ? mine.length >= 1 && mine.length <= 4 : mine.length === 4) && documents('/never').length === 0, `${mine.length} | ${mine.map(seen => seen.at - began).join(',')} | ${documents('/never').length} | ${took} ms`)
}

section('S12 a first navigation aborted every time before a request left fails after four starts')
{
  attempts = 0
  unsent = 9
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/four` }, fourth)
  const took = Date.now() - began
  unsent = 0
  check('it fails in the words it always had', opened.outcome === 'failed' && opened.result === ABORTED('/four'), opened.result)
  check('four navigations were started and no more, and nothing reached the server', (selfDropped(`${A.origin}/four`, began) ? attempts >= 1 && attempts <= 4 : attempts === 4 && took >= 9000) && documents('/four').length === 0, `${attempts} | ${documents('/four').length} | ${took} ms`)
}

sessions.setBrowserLaunchDriverForProof(null)

section('S13 a slow page reached through a redirect the profile remembers is asked for once')
{
  const first = await run({ op: 'open', url: `${A.origin}/moved-far` }, kept)
  await run({ op: 'close' }, kept)
  const askedRedirect = documents('/moved-far').length
  const askedPage = asksFor('/far')
  farMs = 6500
  const began = Date.now()
  const again = await run({ op: 'open', url: `${A.origin}/moved-far`, timeoutMs: 20000 }, kept)
  const took = Date.now() - began
  farMs = 0
  check('the first open follows the redirect to the page', first.outcome === 'succeeded' && first.result.startsWith(`open: http://localhost:${F.port}/far [200] — far`) && askedRedirect === 1 && askedPage === 1, `${first.result} | ${askedRedirect} | ${askedPage}`)
  check('the open on the remembered redirect answers with the page when its server does', again.outcome === 'succeeded' && again.result.startsWith(`open: http://localhost:${F.port}/far [200] — far`) && took >= 6000, `${again.result} | ${took} ms`)
  check('the redirect came from the profile and the page was asked for once', documents('/moved-far').length === askedRedirect && asksFor('/far') === askedPage + 1, `${documents('/moved-far').length - askedRedirect} | ${asksFor('/far') - askedPage}`)
}

section('S14 a download reached through a redirect the profile remembers is fetched once')
{
  const first = await run({ op: 'open', url: `${A.origin}/moved` }, fetched)
  await run({ op: 'close' }, fetched)
  const askedRedirect = documents('/moved').length
  const askedFile = asksFor('/report.csv')
  const again = await run({ op: 'open', url: `${A.origin}/moved`, timeoutMs: 15000 }, fetched)
  check('the first open follows the redirect and saves the file', first.outcome === 'succeeded' && first.result.includes('is a download') && askedRedirect === 1 && askedFile === 1, `${first.result} | ${askedRedirect} | ${askedFile}`)
  check('the open on the remembered redirect saves the file again', again.outcome === 'succeeded' && again.result.includes('is a download'), again.result)
  check('the redirect came from the profile and the file was asked for once', documents('/moved').length === askedRedirect && asksFor('/report.csv') === askedFile + 1, `${documents('/moved').length - askedRedirect} | ${asksFor('/report.csv') - askedFile}`)
}

await finish('prove-browser-first-navigation', [plain, aborted, reached, twice, refused, quiet, slow, halted, thrice, stuck, fourth, kept, fetched])
