#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { removeScratch } from '../lib/removeScratch.ts'

const { ROOT, check, finish, lead, pageOf, permission, requireBrowser, run, section, serve } = await import('./harness.ts')

await requireBrowser()
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

const fixture = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const name = new URL(req.url ?? '/', 'http://fixture').pathname.slice(1) || 'root'
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(
    `<!doctype html><title>${name}</title><button id="go" onclick="document.title='${name} clicked '+(++window.clicks)">go</button> <a id="more" href="/next-${name}">Learn more</a> <input id="box" aria-label="box"><script>window.clicks=0;window.painted=0;(function tick(){window.painted++;requestAnimationFrame(tick)})()</script>`,
  )
}
const site = await serve(0, fixture)

const resolved: { executablePath: string } = resolveBrowser()
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-covered-'))
const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank']
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox')
const user: ChildProcess = spawn(resolved.executablePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
const socket = await new Promise<string>((done, fail) => {
  let seen = ''
  const lapse = setTimeout(() => fail(new Error(`the fixture Chromium never printed its debugging address: ${seen.slice(-400)}`)), 30_000)
  user.stderr?.on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8')
    const hit = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
    if (hit === null) return
    clearTimeout(lapse)
    done(hit[1]!)
  })
  user.once('exit', code => fail(new Error(`the fixture Chromium exited (${code}) before it listened: ${seen.slice(-400)}`)))
})
const endpoint = `http://127.0.0.1:${new URL(socket).port}`

const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as {
  Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } }
}
const sent: string[] = []
const unknownCommand = { name: '' }
const rawSend = Connection.prototype._rawSend
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, ...rest: unknown[]) {
  sent.push(String(method))
  if (method === unknownCommand.name) return Promise.reject(new Error(`'${unknownCommand.name}' wasn't found`))
  return rawSend.call(this, callbacks, method, ...rest)
}
const raises = (): number => sent.filter(method => method === 'Page.bringToFront').length

const desk = await puppeteer.connect({ browserWSEndpoint: socket, defaultViewport: null })
const shown = await desk.newPage()
await shown.goto(`${site.origin}/covered`)
const deskSession = await shown.createCDPSession()
const { windowId } = await deskSession.send('Browser.getWindowForTarget')
const cover = async (): Promise<void> => {
  await deskSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
}
const uncover = async (): Promise<void> => {
  await deskSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
}
const windowState = async (): Promise<string> => (await deskSession.send('Browser.getWindowBounds', { windowId })).bounds.windowState ?? 'unknown'
const paints = async (page: typeof shown, ms: number): Promise<number> =>
  page.evaluate(async wait => {
    const before = Number(Reflect.get(window, 'painted'))
    await new Promise(done => setTimeout(done, wait))
    return Number(Reflect.get(window, 'painted')) - before
  }, ms)
const DEADLINE = 4000
const kept = (answer: { ms: number; outcome: string }): boolean => answer.outcome === 'succeeded' && answer.ms <= DEADLINE
const alive = (answer: { result: string }): boolean => user.exitCode === null && !answer.result.includes('may be gone') && !answer.result.includes('is gone')

try {
  section('S1 the scene: the window of the attached browser is covered, its page paints no frame and still answers a read')
  const joined = await run({ op: 'attach', endpoint })
  const tab = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(line => line.includes(`${site.origin}/covered`)) ?? '')?.[1] ?? 'tab-missing'
  await permission({ op: 'extract', tab })
  const read = await run({ op: 'extract', tab, mode: 'tree' })
  check('the tab is joined and read', joined.outcome === 'succeeded' && tab.startsWith('tab-') && read.result.includes('Learn more'), `${joined.result} | ${read.result}`)
  const before = await paints(shown, 400)
  await cover()
  const after = await paints(shown, 600)
  const info = await run({ op: 'info', tab })
  check('covered, the page paints no frame', before > 0 && after === 0 && (await windowState()) === 'minimized', `frames before ${before}, covered ${after}, window ${await windowState()}`)
  check('and a read of it still answers at once', info.outcome !== 'failed' && info.ms < 2000, `${info.ms}ms ${info.result}`)

  section('S2 the first act on the covered page lands, and the window stays where its user left it')
  await permission({ op: 'click', tab, selector: '#go' })
  const first = await run({ op: 'click', tab, selector: '#go', timeoutMs: DEADLINE })
  const stayed = await windowState()
  check('the click lands within its deadline', kept(first) && (await pageOf(lead, tab).title()) === 'covered clicked 1', `${first.ms}ms ${first.result}`)
  check('the window was not brought to the front', stayed === 'minimized' && raises() === 0, `window ${stayed} · Page.bringToFront sent ${raises()} time(s)`)
  await uncover()
  await cover()

  section('S3 every later click on the covered page keeps its deadline, and none calls the live browser gone')
  const byText = await run({ op: 'click', tab, selector: 'text/go', timeoutMs: DEADLINE })
  const held = !kept(byText)
  check('a click by text', kept(byText) && alive(byText) && (await pageOf(lead, tab).title()) === 'covered clicked 2', `${byText.ms}ms ${byText.result}`)
  if (held) check('the other acts were not tried: the click before them did not keep its deadline', false)
  else {
    const byPoint = await run({ op: 'click', tab, x: 20, y: 16, timeoutMs: DEADLINE })
    check('a click at a point', kept(byPoint) && alive(byPoint) && (await pageOf(lead, tab).title()) === 'covered clicked 3', `${byPoint.ms}ms ${byPoint.result}`)
    const hovered = await run({ op: 'hover', tab, selector: '#go', timeoutMs: DEADLINE })
    check('a hover', kept(hovered) && alive(hovered), `${hovered.ms}ms ${hovered.result}`)
    const typed = await run({ op: 'type', tab, selector: '#box', text: 'covered words', timeoutMs: DEADLINE })
    const value = await pageOf(lead, tab).evaluate(() => document.querySelector<HTMLInputElement>('#box')?.value ?? '')
    check('typing into a field', kept(typed) && alive(typed) && value === 'covered words', `${typed.ms}ms ${typed.result} | value ${value}`)
    const pressed = await run({ op: 'press', tab, key: 'Tab', timeoutMs: DEADLINE })
    check('a key press', kept(pressed) && alive(pressed), `${pressed.ms}ms ${pressed.result}`)
    const scrolled = await run({ op: 'scroll', tab, dy: 10, timeoutMs: DEADLINE })
    check('a scroll', kept(scrolled) && alive(scrolled), `${scrolled.ms}ms ${scrolled.result}`)
    const missing = await run({ op: 'click', tab, selector: 'aria/Nowhere[role="link"]', timeoutMs: 1500 })
    check('a target that is not there fails in the words of its own deadline, at that deadline', missing.outcome === 'failed' && missing.result.includes('within the 1500ms deadline') && missing.ms < 3000 && alive(missing), `${missing.ms}ms ${missing.result}`)
    const byRole = await run({ op: 'click', tab, selector: 'aria/Learn more[role="link"]', timeoutMs: DEADLINE })
    check('a click on a link by its role moves the page', kept(byRole) && alive(byRole) && byRole.result.includes(`navigated to ${site.origin}/next-covered`), `${byRole.ms}ms ${byRole.result}`)
    check('through all of it the window stayed covered and was never raised', (await windowState()) === 'minimized' && raises() === 0, `window ${await windowState()} · Page.bringToFront sent ${raises()} time(s)`)
    console.log(`  covered acts answered in: first click ${first.ms}ms · by text ${byText.ms}ms · at a point ${byPoint.ms}ms · hover ${hovered.ms}ms · type ${typed.ms}ms · by role ${byRole.ms}ms`)
  }

  section('S4 a tab that is not the one on show: the act lands and the tab on show stays on show')
  if (held) check('not tried: a covered click did not keep its deadline', false)
  else {
    await uncover()
    const onShow = await desk.newPage()
    await onShow.goto(`${site.origin}/onshow`)
    const behind = await run({ op: 'click', tab, selector: '#go', timeoutMs: DEADLINE })
    const showing = await onShow.evaluate(() => document.visibilityState)
    check('the click lands on the tab behind', kept(behind) && alive(behind) && (await pageOf(lead, tab).title()) === 'next-covered clicked 1', `${behind.ms}ms ${behind.result}`)
    check('the tab its user was looking at is still the one on show', showing === 'visible' && (await paints(onShow, 300)) > 0 && raises() === 0, `on show: ${showing} · Page.bringToFront sent ${raises()} time(s)`)

    section('S5 a browser that does not know how to keep a covered page painting: there, and only there, the tab is brought to the front')
    const listed = await run({ op: 'status' })
    const other = /^\s*(tab-\d+): /.exec(listed.result.split('\n').find(line => line.includes(`${site.origin}/onshow`)) ?? '')?.[1] ?? 'tab-missing'
    unknownCommand.name = 'Emulation.setFocusEmulationEnabled'
    await permission({ op: 'click', tab: other, selector: '#go' })
    const fallback = await run({ op: 'click', tab: other, selector: '#go', timeoutMs: DEADLINE })
    unknownCommand.name = ''
    check('the click lands, with the tab brought to the front once', kept(fallback) && alive(fallback) && raises() === 1 && (await onShow.title()) === 'onshow clicked 1', `${fallback.ms}ms ${fallback.result} · Page.bringToFront sent ${raises()} time(s)`)

    section('S6 a tab Mercury opens there is added behind the tab on show, and is driven where it stands')
    const shownBefore = await onShow.evaluate(() => document.visibilityState)
    await permission({ op: 'open', url: `${site.origin}/opened`, tab: 'fresh' })
    const opened = await run({ op: 'open', url: `${site.origin}/opened`, tab: 'fresh' })
    const shownAfter = await onShow.evaluate(() => document.visibilityState)
    check('open adds the tab and reads it', opened.outcome === 'succeeded' && opened.result.includes(`open: ${site.origin}/opened [200] — opened (attached: ${endpoint})`), opened.result)
    check('the tab that was on show is still the one on show', shownBefore === 'visible' && shownAfter === 'visible' && (await paints(onShow, 300)) > 0, `on show before ${shownBefore}, after ${shownAfter}`)
    const inFresh = await run({ op: 'click', tab: 'fresh', selector: '#go', timeoutMs: DEADLINE })
    check('a click in the tab Mercury opened lands within its deadline', kept(inFresh) && alive(inFresh) && (await pageOf(lead, 'fresh').title()) === 'opened clicked 1', `${inFresh.ms}ms ${inFresh.result}`)
    check('and no window was raised for the new tab', raises() === 1 && (await onShow.evaluate(() => document.visibilityState)) === 'visible', `Page.bringToFront sent ${raises()} time(s)`)
  }
} finally {
  Connection.prototype._rawSend = rawSend
  await desk.disconnect().catch(() => undefined)
  if (user.exitCode === null) user.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-covered', [lead])
