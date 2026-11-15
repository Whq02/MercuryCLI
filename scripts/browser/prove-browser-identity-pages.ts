#!/usr/bin/env bun
import type http from 'node:http'
import { join } from 'node:path'
import { ROOT, check, detect, detectionHtml, finish, lead, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
interface Sent {
  userAgent: string
  platform: string | null
  mobile: string | null
}
const sent = new Map<string, Sent>()
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  const header = (name: string): string | null => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : null)
  sent.set(path, { userAgent: header('user-agent') ?? '', platform: header('sec-ch-ua-platform'), mobile: header('sec-ch-ua-mobile') })
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (path === '/detect') {
    res.end(detectionHtml(req.headers, hostTz))
    return
  }
  res.end(`<!doctype html><title>${path.slice(1) || 'root'}</title>
<script>window.__atLoad = navigator.platform</script>
<a id="pop-detect" target="_blank" href="/detect">detect</a>
<a id="pop-page" target="_blank" href="/popped">page</a>`)
})

interface Facts {
  platform: string
  atLoad: string | null
  userAgent: string
  appVersion: string
  hints: { platform: string; mobile: boolean } | null
}
const facts = (tab?: string): Promise<Facts> =>
  pageOf(lead, tab).evaluate(() => {
    const data = (navigator as unknown as { userAgentData?: { platform: string; mobile: boolean; brands: unknown[] } }).userAgentData
    return {
      platform: navigator.platform,
      atLoad: (window as unknown as { __atLoad?: string }).__atLoad ?? null,
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      hints: data === undefined || data.brands.length === 0 ? null : { platform: data.platform, mobile: data.mobile },
    }
  })
const nineOf = async (tab?: string): Promise<{ passed: number; total: number; checks: Record<string, boolean> }> => detect(lead, tab)
const keptName = (answer: { result: string }): string => /kept as tab (\S+) at/.exec(answer.result)?.[1] ?? ''
const PIXEL = 'Linux armv81'
const isPixel = (now: Facts): boolean => now.platform === PIXEL && /Android 11; Pixel 5/.test(now.userAgent) && now.hints?.platform === 'Android' && now.hints.mobile === true && now.appVersion === now.userAgent.replace(/^Mozilla\//, '')

const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
let attaches = 0
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, ...rest: unknown[]) {
  if (method === 'Target.attachToTarget') attaches++
  return send.call(this, callbacks, method, ...rest)
}

section('S0 control: the page a launch starts with (holds on the parent too)')
await run({ op: 'open', url: `${A.origin}/detect` })
const host = sessions.pageKitOf(pageOf())?.identity?.platform ?? ''
{
  const plain = await nineOf()
  check('the nine baseline assertions hold before any emulation', plain.passed === 9 && plain.total === 9, JSON.stringify(plain.checks))
  const applied = await run({ op: 'viewport', emulation: { device: 'Pixel 5' } })
  await run({ op: 'open', url: `${A.origin}/page` })
  const moved = await facts()
  await run({ op: 'reload' })
  const reloaded = await facts()
  check('with a phone it reads the phone’s platform after a navigation and after a reload', applied.outcome === 'succeeded' && isPixel(moved) && isPixel(reloaded) && reloaded.atLoad === PIXEL, JSON.stringify([moved, reloaded]))
  await run({ op: 'open', url: `${A.origin}/detect` })
  const nine = await nineOf()
  check('and the nine hold on it (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  check('the host’s own platform is another one than the phone’s', host !== '' && host !== PIXEL, host)
}

section('S1 a named tab born beside another page, with a phone')
{
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/page` })
  const before = attaches
  const applied = await run({ op: 'viewport', tab: 'beside', emulation: { device: 'Pixel 5' } })
  const first = await facts('beside')
  check('[E6] right after the device’s own reload the page reads one identity: platform, user agent and client hints', applied.outcome === 'succeeded' && applied.result.includes('(the page was reloaded: mobile or touch changed)') && isPixel(first) && first.atLoad === PIXEL, JSON.stringify(first))
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/next` })
  const moved = await facts('beside')
  check('[M11] after a navigation', isPixel(moved) && moved.atLoad === PIXEL, JSON.stringify(moved))
  await run({ op: 'reload', tab: 'beside' })
  const reloaded = await facts('beside')
  check('[M11] after a reload', isPixel(reloaded) && reloaded.atLoad === PIXEL, JSON.stringify(reloaded))
  check('[E6] and the server is sent that identity', /Android 11; Pixel 5/.test(sent.get('/next')?.userAgent ?? '') && sent.get('/next')?.platform === '"Android"' && sent.get('/next')?.mobile === '?1', JSON.stringify(sent.get('/next')))
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/detect` })
  const nine = await nineOf('beside')
  check('[M13][G5] the nine baseline assertions hold on the emulated named tab (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  check('the identity went out on one session more, attached once', attaches - before === 1, String(attaches - before))
}

section('S2 a tab an act opened from the emulated tab')
{
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/page` })
  const popped = await run({ op: 'click', tab: 'beside', selector: '#pop-detect' })
  const name = keptName(popped)
  check('the popup is kept with its opener’s device', name !== '' && popped.result.includes('the emulation came with it (device Pixel 5)'), popped.result)
  const landed = name === '' ? null : await facts(name)
  const nine = name === '' ? { passed: 0, total: 9, checks: {} } : await nineOf(name)
  check('[E6] it reads the phone’s platform beside the phone’s user agent', landed !== null && isPixel(landed), JSON.stringify(landed))
  check('[M13][G5] the nine baseline assertions hold on the emulated kept tab (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  if (name !== '') await run({ op: 'open', tab: name, url: `${A.origin}/next` })
  const moved = name === '' ? null : await facts(name)
  check('[M11] and after a navigation of its own', moved !== null && isPixel(moved) && moved.atLoad === PIXEL, JSON.stringify(moved))
  if (name !== '') await run({ op: 'close', tab: name })
}

section('S3 a desktop identity of another system, which needs no reload')
{
  const other =
    host === 'Win32'
      ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', platform: 'MacIntel' }
      : { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', platform: 'Win32' }
  await run({ op: 'open', tab: 'desk', url: `${A.origin}/page` })
  const applied = await run({ op: 'viewport', tab: 'desk', emulation: { userAgent: other.userAgent } })
  const live = await facts('desk')
  check('the answer names the identity, and the live page reads it', applied.result.includes(`platform ${other.platform}`) && live.platform === other.platform && live.userAgent === other.userAgent, `${applied.result} ${JSON.stringify(live)}`)
  await run({ op: 'reload', tab: 'desk' })
  const reloaded = await facts('desk')
  check('[E6][M11] the next document reads it too', reloaded.platform === other.platform && reloaded.atLoad === other.platform && reloaded.userAgent === other.userAgent, JSON.stringify(reloaded))
  const popped = await run({ op: 'click', tab: 'desk', selector: '#pop-page' })
  const name = keptName(popped)
  const born = name === '' ? null : await facts(name)
  check('a tab it opens is born with it (holds on the parent too)', born !== null && born.atLoad === other.platform && born.userAgent === other.userAgent, `${popped.result} ${JSON.stringify(born)}`)
  if (name !== '') await run({ op: 'reload', tab: name })
  const again = name === '' ? null : await facts(name)
  check('[E6][M11] and keeps it at its next document', again !== null && again.platform === other.platform && again.atLoad === other.platform, JSON.stringify(again))
  if (name !== '') await run({ op: 'close', tab: name })
  await run({ op: 'close', tab: 'desk' })
}

section('S4 a phone whose browser sends no client hints, then the launch baseline again')
{
  const applied = await run({ op: 'viewport', tab: 'beside', emulation: { device: 'iPhone 15 Pro' } })
  await run({ op: 'reload', tab: 'beside' })
  const now = await facts('beside')
  check('[E6] the platform is the phone’s after a reload, and no client hints are read', applied.outcome === 'succeeded' && now.platform === 'iPhone' && now.atLoad === 'iPhone' && /iPhone; CPU iPhone OS/.test(now.userAgent) && now.hints === null, JSON.stringify(now))
  const reset = await run({ op: 'viewport', tab: 'beside', emulation: { reset: true } })
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/detect` })
  const back = await facts('beside')
  const nine = await nineOf('beside')
  check('[E2] reset restores the launch identity whole, platform included, and the nine hold (9/9)', reset.outcome === 'succeeded' && back.platform === host && nine.passed === 9 && nine.total === 9, `${JSON.stringify(back)} ${JSON.stringify(nine.checks)}`)
}

section('S5 a page that asks for no identity pays nothing')
{
  const before = attaches
  await run({ op: 'open', tab: 'quiet', url: `${A.origin}/page` })
  const born = attaches - before
  const dark = await run({ op: 'viewport', tab: 'quiet', emulation: { colorScheme: 'dark', timezone: 'Asia/Tokyo' } })
  await run({ op: 'reload', tab: 'quiet' })
  check('an emulation that leaves the identity alone attaches no session', dark.outcome === 'succeeded' && attaches - before === born, `${born} ${attaches - before}`)
  check('and the page reads the host’s platform', (await facts('quiet')).platform === host)
}

Connection.prototype._rawSend = send
await finish('prove-browser-identity-pages')
