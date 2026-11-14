#!/usr/bin/env bun
import type http from 'node:http'
import { check, detect, detectionHtml, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions, validate, BrowserTool } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  if (url.pathname === '/headers') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(req.headers))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/env') {
    const served = {
      userAgent: String(req.headers['user-agent'] ?? ''),
      acceptLanguage: String(req.headers['accept-language'] ?? ''),
      mobile: req.headers['sec-ch-ua-mobile'] ?? null,
      platform: req.headers['sec-ch-ua-platform'] ?? null,
      brands: req.headers['sec-ch-ua'] ?? null,
    }
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>env</title><input id="keep"><script>window.__served = ${JSON.stringify(served)}</script>`,
    )
    return
  }
  res.end(detectionHtml(req.headers, url.searchParams.get('tz') ?? hostTz))
}
const A = await serve(27280, handler)
const B = await serve(27281, handler)

interface Facts {
  inner: [number, number]
  dpr: number
  userAgent: string
  appVersion: string
  platform: string
  touchPoints: number
  coarse: boolean
  orientation: string
  hints: { mobile: boolean; platform: string; brands: string[] } | null
  timeZone: string
  hours: number
  language: string
  languages: string[]
  numberLocale: string
  number: string
  dark: boolean
  reduce: boolean
  location: string
  served: { userAgent: string; acceptLanguage: string; mobile: string | null; platform: string | null; brands: string | null } | null
}
const facts = (ctx = lead): Promise<Facts> =>
  pageOf(ctx).evaluate(async () => {
    const data = (navigator as unknown as { userAgentData?: { mobile: boolean; platform: string; brands: Array<{ brand: string }> } }).userAgentData
    return {
      inner: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      touchPoints: navigator.maxTouchPoints,
      coarse: matchMedia('(pointer: coarse)').matches,
      orientation: screen.orientation?.type ?? '',
      hints: data ? { mobile: data.mobile, platform: data.platform, brands: data.brands.map(b => b.brand) } : null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hours: new Date(Date.UTC(2026, 0, 15, 12)).getHours(),
      language: navigator.language,
      languages: [...navigator.languages],
      numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
      number: (1234.5).toLocaleString(),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      location: (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state,
      served: (window as unknown as { __served?: Facts['served'] }).__served ?? null,
    } as Facts
  })
const position = (ctx = lead): Promise<string> =>
  pageOf(ctx).evaluate(
    () =>
      new Promise<string>(done =>
        navigator.geolocation.getCurrentPosition(
          p => done(`${p.coords.latitude},${p.coords.longitude},${p.coords.accuracy}`),
          e => done(`error ${e.code}`),
          { timeout: 2500 },
        ),
      ),
  )
const spin = async (): Promise<number> => {
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    runs.push(
      await pageOf().evaluate(() => {
        const t0 = performance.now()
        let x = 0
        for (let n = 0; n < 3e7; n++) x += n % 7
        return performance.now() - t0 + (x > 0 ? 0 : 0)
      }),
    )
  }
  return Math.min(...runs)
}
const fetchMs = (): Promise<number | string> =>
  pageOf().evaluate(async () => {
    const t0 = performance.now()
    try {
      await (await fetch('/headers', { cache: 'no-store' })).text()
      return performance.now() - t0
    } catch (err) {
      return `rejected: ${(err as Error).message}`
    }
  })
const emulate = (emulation: Record<string, unknown>, size: Record<string, number> = {}, ctx = lead) => run({ op: 'viewport', ...size, emulation }, ctx)
const hostPlatform = (await import('node:os')).platform()

section('S0 controls: the plain call, its clamps, its sentence and the baseline (these hold on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/env` })
  check('the fixture opens', opened.outcome === 'succeeded', opened.result)
  const resized = await run({ op: 'viewport', width: 900, height: 600 })
  check('[E1] a plain viewport call answers in today’s exact words', resized.result === `viewport: 900x600 at ${A.origin}/env` && resized.outcome === 'succeeded', resized.result)
  const clamped = await run({ op: 'viewport', width: 100, height: 100, deviceScaleFactor: 9 })
  check('[E1] a plain viewport call keeps today’s clamps (320, 240, scale 3)', clamped.result === `viewport: 320x240 @3x at ${A.origin}/env`, clamped.result)
  const missing = await validate({ op: 'viewport', width: 900 })
  check('[E1] a plain viewport call without both sizes keeps today’s sentence', !missing.ok && missing.message === 'viewport requires width and height (CSS px)', missing.message)
  await run({ op: 'viewport', width: 1280, height: 800 })
  const info = await run({ op: 'info' })
  check('[M12] info with no emulation is today’s four lines', info.result.split('\n').length === 4 && !/emulation/.test(info.result) && info.result.endsWith('viewport: 1280x800'), info.result)
  await run({ op: 'open', url: `${A.origin}/` })
  const nine = await detect()
  check('[G5] the nine baseline assertions hold before any emulation (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  await run({ op: 'open', url: `${A.origin}/env` })
}
const baseline = await facts()

section('S1 the device catalogue')
{
  const bystander = { agentId: 'emulation-bystander' }
  const listed = await run({ op: 'devices' }, bystander)
  const [head = '', body = ''] = listed.result.split('\n')
  const names = body.split(', ')
  check('[M01] devices lists the shipped driver’s catalogue and names the driver version', head.startsWith(`devices: ${names.length} profiles in puppeteer-core ${sessions.driverVersion()}`) && names.length >= 100, head)
  check('[M01] the names come in one stable order', JSON.stringify([...names].sort()) === JSON.stringify(names) && names.includes('iPhone 15 Pro') && names.includes('Pixel 5'))
  check('[M01] listing starts no browser and changes nothing', listed.outcome === 'no-change' && !sessions.liveBrowserSessionCensus().some((row: { owner: string }) => row.owner === ownerOf(bystander)))
  const unknown = await emulate({ device: 'iPhone 99' })
  check('[M01] an unknown device is answered with how to get the list, and nothing changes', unknown.outcome === 'failed' && unknown.result.includes('no device named "iPhone 99"') && unknown.result.includes('op:"devices" lists the') && unknown.result.includes('near: iPhone') && unknown.result.endsWith('nothing changed'), unknown.result)
  check('[M01] the page is as it was after the refusal', JSON.stringify(await facts()) === JSON.stringify(baseline))
}

section('S2 a device from the catalogue: Pixel 5 (a Chromium phone)')
{
  const hitsBefore = A.hits.length
  const applied = await emulate({ device: 'Pixel 5' })
  const lines = applied.result.split('\n')
  check('[M02][E6] the answer says what was applied: size, scale, mobile, touch, the reload, the device and its identity', applied.outcome === 'succeeded' && lines[0] === `viewport: 393x851 @3x mobile touch at ${A.origin}/env (the page was reloaded: mobile or touch changed)` && lines[1] === `  device: Pixel 5 (puppeteer-core ${sessions.driverVersion()})` && /^  user agent: Mozilla\/5\.0 \(Linux; Android 11; Pixel 5\).* — platform Linux armv81; client hints Android, mobile, model Pixel 5$/.test(lines[2] ?? ''), applied.result)
  const now = await facts()
  check('[M02] the page has the device’s viewport and pixel ratio', now.inner[0] === 393 && now.inner[1] === 851 && now.dpr === 3, JSON.stringify(now.inner))
  check('[M02] the page is mobile and touch, not a relabelled desktop', now.touchPoints > 0 && now.coarse && now.hints?.mobile === true, JSON.stringify([now.touchPoints, now.coarse, now.hints]))
  check('[E6] one identity: the user agent, the platform and the client hints the page reads', /Android 11; Pixel 5/.test(now.userAgent) && now.platform === 'Linux armv81' && now.hints?.platform === 'Android' && now.appVersion === now.userAgent.replace(/^Mozilla\//, ''), JSON.stringify([now.userAgent, now.platform, now.hints]))
  check('[E6] one identity: what the server was sent on the reload', A.hits.length > hitsBefore && now.served?.userAgent === now.userAgent && now.served?.mobile === '?1' && now.served?.platform === '"Android"' && /"Chromium";v="99"/.test(now.served?.brands ?? ''), JSON.stringify(now.served))
  await run({ op: 'open', url: `${A.origin}/` })
  const nine = await detect()
  check('[M13][G5] the nine baseline assertions hold UNCHANGED on the emulated page (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  const clicked = await run({ op: 'click', selector: '#click-target' })
  const telemetry = await pageOf().evaluate(() => (window as unknown as { __telemetry: { clicked: number; moves: unknown[]; allTrusted: boolean; downAt: number; upAt: number } }).__telemetry)
  check('[G5] input on the emulated page is the human-paced road (a curved approach, a held press, trusted events)', clicked.outcome === 'succeeded' && telemetry.clicked === 1 && telemetry.moves.length >= 8 && telemetry.allTrusted && telemetry.upAt - telemetry.downAt >= 10, JSON.stringify({ moves: telemetry.moves.length, hold: telemetry.upAt - telemetry.downAt, trusted: telemetry.allTrusted }))
  await run({ op: 'open', url: `${A.origin}/env` })
  const kept = await facts()
  check('[M11] navigation keeps the device', kept.inner[0] === 393 && kept.dpr === 3 && /Pixel 5/.test(kept.userAgent) && kept.served?.mobile === '?1', JSON.stringify(kept.inner))
}

section('S3 a device whose browser sends no client hints: iPhone 15 Pro')
{
  const applied = await emulate({ device: 'iPhone 15 Pro' })
  check('[M02] a second device replaces the first, and the answer says the document predates it', applied.outcome === 'succeeded' && applied.result.includes('device: iPhone 15 Pro') && !applied.result.includes('Pixel 5') && applied.result.includes('platform iPhone; client hints not sent') && applied.result.includes('op:"reload" asks the server again'), applied.result)
  await run({ op: 'reload' })
  const now = await facts()
  check('[E6] one identity: iPhone user agent, iPhone platform, and no client hints sent or readable', /iPhone; CPU iPhone OS/.test(now.userAgent) && now.platform === 'iPhone' && now.served?.userAgent === now.userAgent && now.served?.mobile === null && now.served?.platform === null && now.served?.brands === null && (now.hints === null || now.hints.brands.length === 0), JSON.stringify([now.platform, now.served, now.hints]))
  check('[M02] the device’s size and ratio', now.inner[0] === 393 && now.inner[1] === 659 && now.dpr === 3, JSON.stringify(now.inner))
  await run({ op: 'open', url: `${A.origin}/` })
  const nine = await detect()
  const untouched = Object.keys(nine.checks).filter(name => name !== 'clientHints' && name !== 'uaConsistency')
  check('[M13] the seven assertions an identity does not touch hold unchanged on the iPhone page', untouched.length === 7 && untouched.every(name => nine.checks[name] === true), JSON.stringify(nine.checks))
  const coherent = await pageOf().evaluate(() => {
    const served = (window as unknown as { serverHeaders?: unknown }).serverHeaders
    return { header: document.querySelector('script')!.textContent!.includes(navigator.userAgent), served: typeof served }
  })
  check('[M13] the two identity assertions read the requested identity: the server saw the user agent the page reports', coherent.header, JSON.stringify(coherent))
  await run({ op: 'open', url: `${A.origin}/env` })
}

section('S4 explicit fields over the device, and raw values')
{
  const over = await emulate({ userAgent: 'ProofAgent/1.0 (raw)' }, { width: 500, height: 900, deviceScaleFactor: 4.5 })
  const now = await facts()
  check('[M03][E2] explicit size, scale and user agent win over the device, taken as given', over.outcome === 'succeeded' && over.result.startsWith('viewport: 500x900 @4.5x mobile touch') && now.inner[0] === 500 && now.dpr === 4.5 && now.userAgent === 'ProofAgent/1.0 (raw)', `${over.result} ${JSON.stringify(now.inner)}`)
  check('[E6] a user agent no platform can be derived from keeps the browser’s own platform and sends no client hints, and says so', over.result.includes("ProofAgent/1.0 (raw) — platform the browser's own; client hints not sent") && now.platform === baseline.platform, over.result)
  await run({ op: 'reload' })
  const served = (await facts()).served
  check('[E6] the server is sent the raw user agent and no stale desktop hints', served?.userAgent === 'ProofAgent/1.0 (raw)' && served?.brands === null && served?.platform === null, JSON.stringify(served))
  const back = await emulate({ userAgent: null })
  check('[E2] null clears one field: the device’s user agent is back, the explicit size stays', (await facts()).inner[0] === 500 && /iPhone/.test((await facts()).userAgent) && back.outcome === 'succeeded', back.result)
  const none = await emulate({ device: null })
  const plain = await facts()
  check('[E2] clearing the device drops its mobile, touch and user agent and keeps the explicit size', none.outcome === 'succeeded' && plain.inner[0] === 500 && plain.dpr === 4.5 && plain.touchPoints === 0 && plain.userAgent === baseline.userAgent && !none.result.includes('device:'), `${none.result} ${JSON.stringify([plain.inner, plain.touchPoints])}`)
  const raw = await emulate({ mobile: true, touch: true, landscape: true }, { width: 240, height: 200 })
  const tiny = await facts()
  check('[B04][E1] raw mobile, touch and orientation with no device, and a size below the plain clamp', raw.outcome === 'succeeded' && raw.result.startsWith('viewport: 240x200 @4.5x mobile touch landscape') && tiny.inner[0] === 240 && tiny.touchPoints > 0 && /landscape/.test(tiny.orientation), `${raw.result} ${JSON.stringify([tiny.inner, tiny.orientation])}`)
  const reset = await emulate({ reset: true })
  check('[E2] reset restores the launch baseline whole', reset.outcome === 'succeeded' && reset.result.includes('emulation: none, the launch baseline is restored') && JSON.stringify(await facts()) === JSON.stringify(baseline), reset.result)
}

section('S5 timezone and locale')
{
  const applied = await emulate({ timezone: 'Asia/Tokyo', locale: 'fr-FR' })
  const now = await facts()
  check('[M05] the timezone reaches the page’s clock', applied.outcome === 'succeeded' && now.timeZone === 'Asia/Tokyo' && now.hours === 21 && applied.result.includes('  timezone: Asia/Tokyo'), JSON.stringify([now.timeZone, now.hours]))
  check('[M05][E6] the locale reaches formatting and the languages the page reads, without a reload', now.numberLocale === 'fr-FR' && now.number !== baseline.number && now.language === 'fr-FR' && JSON.stringify(now.languages) === '["fr-FR","fr"]' && applied.result.includes('  locale: fr-FR (languages fr-FR, fr)'), JSON.stringify([now.numberLocale, now.number, now.languages]))
  await run({ op: 'open', url: `${A.origin}/?tz=Asia/Tokyo` })
  const nine = await detect()
  check('[M13][E6] the nine assertions hold unchanged on the page with its requested zone and languages (header, navigator and clock agree)', nine.passed === 9, JSON.stringify(nine.checks))
  check('[E6] the server is sent the requested language first', String(A.hits[A.hits.length - 1]?.headers['accept-language']).startsWith('fr-FR,fr'), String(A.hits[A.hits.length - 1]?.headers['accept-language']))
  await run({ op: 'open', url: `${A.origin}/env` })
  const bad = await emulate({ timezone: 'Mars/Phobos' })
  check('[M05][B02] a zone the browser refuses is named with the browser’s words, the answer fails, and the earlier zone stays', bad.outcome === 'failed' && bad.result.includes('timezone NOT applied (timezone "Mars/Phobos"): Invalid timezone id — the earlier value stays') && bad.result.includes('  timezone: Asia/Tokyo') && (await facts()).timeZone === 'Asia/Tokyo', bad.result)
  const badLocale = await emulate({ locale: 'not a locale', colorScheme: 'light' })
  const after = await facts()
  check('[B02] one refused field does not take the others down: the scheme applies, the locale stays', badLocale.outcome === 'failed' && badLocale.result.includes('locale NOT applied (locale "not a locale")') && after.language === 'fr-FR' && after.numberLocale === 'fr-FR' && after.dark === false && badLocale.result.includes('prefers-color-scheme light'), badLocale.result)
  const cleared = await emulate({ timezone: null })
  const kept = await facts()
  check('[M05][E2] null clears the zone alone, back to the launch baseline, and the locale stays', cleared.outcome === 'succeeded' && kept.timeZone === baseline.timeZone && kept.language === 'fr-FR' && !cleared.result.includes('timezone:'), cleared.result)
  const later = await emulate({ timezone: 'America/New_York', locale: null, colorScheme: null })
  const recovered = await facts()
  check('[B02] a refused value poisons nothing: the next call applies', later.outcome === 'succeeded' && recovered.timeZone === 'America/New_York' && recovered.language === baseline.language && JSON.stringify(recovered.languages) === JSON.stringify(baseline.languages), later.result)
  await emulate({ reset: true })
}

section('S6 processor slowdown')
{
  const before = await spin()
  const applied = await emulate({ cpuSlowdown: 6 })
  const slowed = await spin()
  check('[M06] the slowdown applies to this page (a busy loop takes several times longer)', applied.outcome === 'succeeded' && applied.result.includes('  cpu: 6x slowdown') && slowed > before * 2.5, `${before.toFixed(1)}ms -> ${slowed.toFixed(1)}ms`)
  const large = await emulate({ cpuSlowdown: 60 })
  check('[M06] no ceiling of Mercury’s on the factor', large.outcome === 'succeeded' && large.result.includes('  cpu: 60x slowdown'), large.result)
  const cleared = await emulate({ cpuSlowdown: null })
  const after = await spin()
  check('[M06] null clears it', cleared.outcome === 'succeeded' && !cleared.result.includes('cpu:') && after < slowed / 2, `${after.toFixed(1)}ms`)
}

section('S7 network conditions and offline')
{
  const free = Math.max(Number(await fetchMs()), Number(await fetchMs()))
  const custom = await emulate({ network: { download: 500000, upload: 500000, latency: 700 } })
  const throttled = Math.min(Number(await fetchMs()), Number(await fetchMs()))
  check('[M07] custom throughput and latency apply (a request takes its latency)', custom.outcome === 'succeeded' && custom.result.includes('  network: 500000 B/s down, 500000 B/s up, 700 ms latency') && throttled >= 600 && free < 400, `${free.toFixed(0)}ms -> ${throttled.toFixed(0)}ms`)
  const preset = await emulate({ network: 'slow3g' })
  check('[M07] a preset is the driver’s own numbers, said in the answer', preset.outcome === 'succeeded' && preset.result.includes('  network: slow3g: 50000 B/s down, 50000 B/s up, 2000 ms latency'), preset.result)
  const offline = await emulate({ network: null, offline: true })
  check('[M07] clearing the throttle is not going online: offline holds on its own', offline.outcome === 'succeeded' && offline.result.includes('  network: offline') && String(await fetchMs()).startsWith('rejected'), offline.result)
  const online = await emulate({ offline: false })
  const restored = Number(await fetchMs())
  check('[M07] online again, and no throttle left', online.outcome === 'succeeded' && restored < 400, `${restored}`)
  await emulate({ offline: null })
}

section('S8 geolocation')
{
  const grantsBefore = JSON.stringify(sessions.approvedOriginList(ownerOf(lead)))
  const applied = await emulate({ geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 12 } })
  check('[M08][E5] the page reads the requested position under the browser’s own permission', applied.outcome === 'succeeded' && (await position()) === '48.8566,2.3522,12' && (await facts()).location === 'granted' && applied.result.includes(`the browser's own location permission is granted to ${A.origin}`), `${applied.result} ${await position()}`)
  check('[E5] it creates no approval of Mercury’s', JSON.stringify(sessions.approvedOriginList(ownerOf(lead))) === grantsBefore && !sessions.originApproved(ownerOf(lead), B.origin))
  await pageOf().goto(`${B.origin}/env`)
  check('[M08] it survives a navigation to another origin, whose permission the browser grants too', (await position()) === '48.8566,2.3522,12' && (await facts()).location === 'granted', await position())
  check('[E5] and still no approval of Mercury’s for that origin', !sessions.originApproved(ownerOf(lead), B.origin))
  const bad = await emulate({ geolocation: { latitude: 200, longitude: 2 } })
  check('[B02] a position the browser refuses is named and the earlier one stays', bad.outcome === 'failed' && bad.result.includes('geolocation NOT applied') && (await position()) === '48.8566,2.3522,12', bad.result)
  const cleared = await emulate({ geolocation: null })
  const after = await facts()
  check('[M08] null clears the override and the browser’s permission', cleared.outcome === 'succeeded' && after.location === baseline.location && (await position()).startsWith('error') && !cleared.result.includes('geolocation'), `${cleared.result} ${after.location}`)
  await pageOf().goto(`${A.origin}/env`)
}

section('S9 colour scheme and reduced motion')
{
  const scheme = baseline.dark ? 'light' : 'dark'
  const first = await emulate({ colorScheme: scheme })
  const second = await emulate({ reducedMotion: !baseline.reduce })
  const now = await facts()
  check('[M09][M04] two calls merge: both preferences hold together', first.outcome === 'succeeded' && second.outcome === 'succeeded' && now.dark === !baseline.dark && now.reduce === !baseline.reduce && second.result.includes(`prefers-color-scheme ${scheme}; prefers-reduced-motion ${baseline.reduce ? 'no-preference' : 'reduce'}`), second.result)
  const one = await emulate({ colorScheme: null })
  const half = await facts()
  check('[M09][E2] one returns to the baseline, the other stays', one.outcome === 'succeeded' && half.dark === baseline.dark && half.reduce === !baseline.reduce, one.result)
  await emulate({ reducedMotion: null })
  check('[M09] both back at the launch baseline', JSON.stringify(await facts()) === JSON.stringify(baseline))
}

section('S10 a plain resize while a device is active')
{
  await emulate({ device: 'Pixel 5' })
  const resized = await run({ op: 'viewport', width: 800, height: 100 })
  const now = await facts()
  check('[E3] the size changes with today’s clamps, the device keeps its mobile, touch, scale and user agent, and the answer says so', resized.outcome === 'succeeded' && resized.result === `viewport: 800x240 @3x mobile touch at ${A.origin}/env\n  kept: device Pixel 5 with its mobile, touch, scale and user agent` && now.inner[0] === 800 && now.dpr === 3 && now.touchPoints > 0 && /Pixel 5/.test(now.userAgent), `${resized.result} ${JSON.stringify(now.inner)}`)
  const scaled = await run({ op: 'viewport', width: 800, height: 600, deviceScaleFactor: 2 })
  check('[E3] a scale given with the plain resize is taken (clamped as today)', scaled.result.startsWith('viewport: 800x600 @2x mobile touch') && scaled.result.includes('kept: device Pixel 5 with its mobile, touch and user agent') && (await facts()).dpr === 2, scaled.result)
  const again = await emulate({ device: 'Pixel 5' })
  check('[E2] choosing the device again takes its own size back', again.result.startsWith('viewport: 393x851 @3x mobile touch') && (await facts()).inner[0] === 393, again.result)
}

section('S10b a reload the browser needs and cannot have')
{
  await emulate({ reset: true })
  const C = await serve(27282, handler)
  await pageOf().goto(`${C.origin}/env`)
  await C.close()
  const applied = await emulate({ device: 'Pixel 5' })
  check('[B02] the device is applied and the answer says the reload met the browser’s own error page, with its cause', applied.outcome === 'succeeded' && applied.result.startsWith('viewport: 393x851 @3x mobile touch at chrome-error://chromewebdata/ (the browser\'s own error page — net::ERR_CONNECTION_REFUSED at http://127.0.0.1:27282/env; the site did not load) (the page was reloaded: mobile or touch changed)') && applied.result.includes('  device: Pixel 5'), applied.result)
  const D = await serve(27282, handler)
  const reloaded = await run({ op: 'open', url: `${D.origin}/env` })
  const now = await facts()
  check('[B02] the next call recovers: the page loads as the device', reloaded.outcome === 'succeeded' && now.inner[0] === 393 && now.served?.mobile === '?1', `${reloaded.result} ${JSON.stringify(now.inner)}`)
  await run({ op: 'open', url: `${A.origin}/env` })
  await emulate({ reset: true })

  const stub = { agentId: 'emulation-stub' }
  let size: unknown = null
  const page = {
    url: () => 'http://127.0.0.1:27280/stub',
    on: () => undefined,
    off: () => undefined,
    once: () => undefined,
    frames: () => [],
    title: async () => 'stub',
    viewport: () => size,
    setViewport: async (next: unknown) => {
      size = next
      throw new Error('Navigation timeout of 30000 ms exceeded')
    },
  }
  sessions.setBrowserLaunchDriverForProof(async () => ({ connected: true, on: () => undefined, off: () => undefined, process: () => null, pages: async () => [page], close: async () => undefined }) as never)
  try {
    await sessions.ensureBrowserSession(ownerOf(stub))
    const thrown = await emulate({ mobile: true }, {}, stub)
    check('[B02] a reload that throws after the size is set is named with its remedy, and the size is reported as set', thrown.outcome === 'failed' && thrown.result === 'viewport: 1280x800 mobile at http://127.0.0.1:27280/stub\n  the size is set, and the reload the browser needs for mobile and touch failed: Navigation timeout of 30000 ms exceeded — op:"reload" tries it again', thrown.result)
    const sessionless = await emulate({ timezone: 'Asia/Tokyo' }, {}, stub)
    check('[B02] a step that cannot run and cannot be put back says both, and promises the next call', sessionless.outcome === 'failed' && sessionless.result.includes('timezone NOT applied (timezone "Asia/Tokyo"): this page has no protocol session of its own — the earlier value stays') && sessionless.result.includes('timezone: the earlier value could not be put back either (this page has no protocol session of its own) — the next emulation call applies it again') && !sessionless.result.includes('  timezone: Asia/Tokyo'), sessionless.result)
  } finally {
    sessions.setBrowserLaunchDriverForProof(null)
    await sessions.disposeBrowserOwner(ownerOf(stub))
  }
}

section('S11 the same tab in another browser, a browser that died, and a fresh one')
{
  await emulate({ device: 'Pixel 5', timezone: 'Asia/Tokyo', geolocation: { latitude: 1.5, longitude: 2.5 } })
  const hitsBefore = B.hits.length
  const moved = await run({ op: 'open', url: `${B.origin}/env` })
  const first = B.hits[hitsBefore]
  check('[M11] opening another origin today starts another browser: the emulation comes with the tab, and the answer says so', moved.outcome === 'succeeded' && moved.result.includes('note: this page is in another browser; the emulation came with it before it loaded (device Pixel 5, timezone Asia/Tokyo, geolocation 1.5, 2.5)'), moved.result)
  check('[M11][G5] the first request of the new browser already carries the device (nothing leaves as the launch identity)', /Android 11; Pixel 5/.test(String(first?.headers['user-agent'])) && first?.headers['sec-ch-ua-mobile'] === '?1', String(first?.headers['user-agent']))
  const now = await facts()
  check('[M11] the page there is the device, in its zone, with its position', now.inner[0] === 393 && now.dpr === 3 && now.timeZone === 'Asia/Tokyo' && (await position()) === '1.5,2.5,0', JSON.stringify([now.inner, now.timeZone]))
  const info = await run({ op: 'info' })
  check('[M12] info describes the tab’s actual environment', info.result.includes('viewport: 393x851 @3x mobile touch') && info.result.includes(`emulation:\n  device: Pixel 5 (puppeteer-core ${sessions.driverVersion()})`) && info.result.includes('  timezone: Asia/Tokyo'), info.result)
  sessions.activeSession(ownerOf(lead)).browser.process()?.kill('SIGKILL')
  await new Promise(done => setTimeout(done, 800))
  const reopened = await run({ op: 'open', url: `${B.origin}/env` })
  check('[M11] a browser that died takes its emulation with it, and the next open names what was lost', reopened.outcome === 'succeeded' && reopened.result.includes('note: the earlier browser is gone and its emulation with it (device Pixel 5, timezone Asia/Tokyo, geolocation 1.5, 2.5) — this page starts at the launch baseline'), reopened.result)
  const fresh = await facts()
  check('[M11] and the new page is the launch baseline', fresh.inner[0] === 1280 && fresh.dpr === baseline.dpr && fresh.timeZone === baseline.timeZone && fresh.userAgent === baseline.userAgent, JSON.stringify(fresh.inner))
  await emulate({ device: 'Pixel 5' })
  await run({ op: 'close' })
  const afterClose = await run({ op: 'open', url: `${A.origin}/env` })
  check('[M11] after close a tab starts fresh and no note is owed', afterClose.outcome === 'succeeded' && !afterClose.result.includes('emulation') && (await facts()).inner[0] === 1280, afterClose.result)
}

section('S12 the whole reset')
{
  const all = await emulate({ device: 'iPhone 15 Pro', timezone: 'Asia/Tokyo', locale: 'de-DE', cpuSlowdown: 4, network: 'fast3g', offline: true, geolocation: { latitude: 10, longitude: 20 }, colorScheme: baseline.dark ? 'light' : 'dark', reducedMotion: !baseline.reduce })
  check('everything set in one call', all.outcome === 'succeeded' && all.result.split('\n').length >= 8, all.result)
  const reset = await emulate({ reset: true })
  check('[B01] reset answers with the baseline restored, online first so the reload it needs succeeds', reset.outcome === 'succeeded' && reset.result === `viewport: 1280x800 at ${A.origin}/env (the page was reloaded: mobile or touch changed)\n  emulation: none, the launch baseline is restored`, reset.result)
  const now = await facts()
  check('[B01] every override is gone from the page', JSON.stringify(now) === JSON.stringify(baseline), JSON.stringify(now))
  check('[B01] the position is no longer granted or served', (await position()).startsWith('error'))
  check('[B01] requests are online and unthrottled', Number(await fetchMs()) < 400)
  const info = await run({ op: 'info' })
  check('[M12] info is today’s four lines again', info.result.split('\n').length === 4 && !/emulation/.test(info.result), info.result)
  await run({ op: 'open', url: `${A.origin}/` })
  const nine = await detect()
  check('[E2][G5] stealth included: the nine baseline assertions hold after the reset (9/9)', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
}

section('S13 the names are checked by the tool, and a wrong one is answered in one line')
{
  const wrong = await validate({ op: 'viewport', emulation: { timeZone: 'Asia/Tokyo' } })
  check('[G2] a wrong name is answered with the valid names', !wrong.ok && wrong.message === 'emulation takes device, userAgent, mobile, touch, landscape, timezone, locale, cpuSlowdown, network, offline, geolocation, colorScheme, reducedMotion, headers, credentials, reset — not "timeZone"', wrong.message)
  const shape = await validate({ op: 'viewport', emulation: { network: 'dialup' } })
  check('[G2] a wrong shape is answered with the shape', !shape.ok && shape.message === 'emulation.network takes slow3g, fast3g, slow4g, fast4g or {download, upload, latency} in bytes/s and ms, or null to clear it', shape.message)
  const elsewhere = await validate({ op: 'click', selector: '#keep', emulation: {} })
  check('emulation belongs to viewport', !elsewhere.ok && elsewhere.message === 'emulation requires op viewport', elsewhere.message)
  const sizeless = await validate({ op: 'viewport', emulation: { timezone: 'Asia/Tokyo' } })
  check('[E1] with emulation the sizes are optional', sizeless.ok, sizeless.message)
  const schema = (await import('zod/v4')).z.toJSONSchema(BrowserTool.inputSchema as never, { io: 'input' }) as { properties: Record<string, { description?: string; properties?: object; enum?: string[] }> }
  const field = schema.properties.emulation
  check('[G2] on the wire emulation is one untyped object with one clause', field?.description === 'viewport: overrides; omitted stays, null clears, reset restores launch defaults' && JSON.stringify(field.properties) === '{}', JSON.stringify(field))
  check('[G2] the definition names no device', !/iPhone|Pixel|Galaxy/.test(JSON.stringify(schema)) && schema.properties.op?.enum?.includes('devices') === true)
  const manual = await BrowserTool.prompt({} as never)
  check('[G2] the manual carries the names and their shapes', manual.includes('Its emulation, kept by the page until reset with sizes as given, takes device (a name from devices), userAgent, mobile, touch, landscape, timezone, locale, cpuSlowdown, network (slow3g, fast3g, slow4g, fast4g or {download, upload, latency} in bytes/s and ms), offline, geolocation {latitude, longitude, accuracy}, colorScheme (dark, light, no-preference), reducedMotion, headers, credentials {username, password or secret (a registered name)}, reset; devices lists the names.'), manual)
}

section('S14 a crewmate has every operation the lead has')
{
  const crewmate = { agentId: 'emulation-crewmate' }
  await run({ op: 'open', url: `${A.origin}/env` }, crewmate)
  const applied = await emulate({ device: 'Pixel 5', timezone: 'Asia/Tokyo' }, {}, crewmate)
  const theirs = await facts(crewmate)
  const mine = await run({ op: 'open', url: `${A.origin}/env` })
  check('[M13] a crewmate emulates as the lead does', applied.outcome === 'succeeded' && theirs.inner[0] === 393 && theirs.timeZone === 'Asia/Tokyo' && /Pixel 5/.test(theirs.userAgent), applied.result)
  check('[M11] and its emulation is its page’s alone: the lead’s page is the baseline', mine.outcome === 'succeeded' && (await facts()).inner[0] === 1280 && (await facts()).timeZone === baseline.timeZone)
  await finish('prove-browser-emulation', [lead, crewmate])
}
