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
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  asked.push({ path, raw: req.rawHeaders })
  if (path === '/held') {
    held = res
    arrived()
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

const { default: driver } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'))) as { default: { launch: (options: LaunchOptions) => Promise<Browser> } }
let unsent = 0
let silent: string | null = null
let attempts = 0
const paused: string[] = []
const startsOf = (url: string): number => paused.filter(seen => seen === url).length
let watcher: CDPSession | null = null
sessions.setBrowserLaunchDriverForProof(async (options: LaunchOptions): Promise<Browser> => {
  const browser = await driver.launch(options)
  const [page] = await browser.pages()
  const cdp = await page!.createCDPSession()
  watcher = cdp
  cdp.on('Fetch.requestPaused', event => {
    if (event.resourceType === 'Document') {
      attempts++
      paused.push(event.request.url)
    }
    if (event.resourceType === 'Document' && event.request.url === silent) {
      silent = null
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
  return browser
})
const ringOf = async (ctx: Ctx): Promise<string> => (await run({ op: 'console' }, ctx)).result
const ABORTED = (path: string): string => `open failed: net::ERR_ABORTED at ${A.origin}${path}`
const droppedByItself = (opened: { outcome: string }, staged: number, starts = attempts): boolean => process.platform === 'win32' && opened.outcome === 'failed' && starts === staged - 1
const notStaged = (what: string): void => console.log(`  [SKIP] ${what}: this launch's browser dropped its first navigation by itself, so the fixture's drop was the second and the one more start was already spent`)

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
  const opened = await run({ op: 'open', url: `${A.origin}/detect` }, aborted)
  unsent = 0
  if (droppedByItself(opened, 2)) notStaged('S1')
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

section('S4 a first navigation aborted twice before a request left fails after the one more start')
{
  attempts = 0
  unsent = 2
  const opened = await run({ op: 'open', url: `${A.origin}/twice` }, twice)
  unsent = 0
  check('it fails in the words it always had', opened.outcome === 'failed' && opened.result === ABORTED('/twice'), opened.result)
  if (droppedByItself(opened, 2)) notStaged('S4, the count of its starts')
  else check('the navigation was started twice and no more, and nothing reached the server', attempts === 2 && documents('/twice').length === 0, `${attempts} | ${documents('/twice').length}`)
}

section('S5 a first navigation that fails another way is not started again')
{
  attempts = 0
  const opened = await run({ op: 'open', url: 'http://127.0.0.1:27299/' }, refused)
  check('a refused connection is named once, as before', opened.outcome === 'failed' && opened.result.includes('net::ERR_CONNECTION_REFUSED') && attempts === 1, `${opened.result} ${attempts}`)
}

section('S6 a first navigation that neither fails nor sends its request is started once more')
{
  silent = `${A.origin}/quiet`
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/quiet`, timeoutMs: 20000 }, quiet)
  const took = Date.now() - began
  silent = null
  const starts = startsOf(`${A.origin}/quiet`)
  if (droppedByItself(opened, 2, starts)) notStaged('S6')
  else {
    check('the open answers with the page', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/quiet [200] — quiet`), opened.result)
    check('the navigation was started twice, the second after five seconds of silence, and the server was asked once', starts === 2 && documents('/quiet').length === 1 && took >= 4500 && took < 16000, `${starts} | ${documents('/quiet').length} | ${took} ms`)
  }
}

section('S7 a slow first navigation whose request has left is not started again')
{
  const began = Date.now()
  const opened = await run({ op: 'open', url: `${A.origin}/slow` }, slow)
  const took = Date.now() - began
  check('the open answers with the page when the server does', opened.outcome === 'succeeded' && opened.result.startsWith(`open: ${A.origin}/slow [200] — slow`) && took >= 6500, `${opened.result} | ${took} ms`)
  check('one navigation was started and the server was asked once', startsOf(`${A.origin}/slow`) === 1 && documents('/slow').length === 1, `${startsOf(`${A.origin}/slow`)} | ${documents('/slow').length}`)
}

section('S8 a later navigation of that browser that goes silent is not started again')
{
  silent = `${A.origin}/later-quiet`
  const later = await run({ op: 'open', url: `${A.origin}/later-quiet`, timeoutMs: 7000 }, quiet)
  silent = null
  check('it waits out its own time and fails in the words it always had', later.outcome === 'failed' && later.result.includes('Navigation timeout of 7000 ms exceeded'), later.result)
  check('one navigation was started and nothing reached the server', startsOf(`${A.origin}/later-quiet`) === 1 && documents('/later-quiet').length === 0, `${startsOf(`${A.origin}/later-quiet`)} | ${documents('/later-quiet').length}`)
}

sessions.setBrowserLaunchDriverForProof(null)
await finish('prove-browser-first-navigation', [plain, aborted, reached, twice, refused, quiet, slow])
