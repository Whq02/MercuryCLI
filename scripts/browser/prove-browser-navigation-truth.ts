#!/usr/bin/env bun
import http from 'node:http'
import { join } from 'node:path'

process.env.MERCURY_BROWSER ??= '1'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { activeSession } = await import('../../src/services/browser/browserSession.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const OWNER = processOwnerForLane(null)
type ToolInput = Parameters<typeof BrowserTool.call>[0]

{
  const first = resolveBrowser()
  if (first.state !== 'ok') {
    const { resolveExecutionProfile } = await import('../lib/executionProfile.ts')
    if (resolveExecutionProfile(ROOT).kind === 'hosted-gate') {
      const { provisionManagedBrowserForTheGate } = await import('../lib/provisionManagedBrowser.ts')
      const provisioned = await provisionManagedBrowserForTheGate(line => console.log(line))
      const again = provisioned.ok ? resolveBrowser() : first
      if (again.state !== 'ok') {
        console.error(`  [FAIL] hosted gate has no drivable browser — ${again.note}`)
        process.exit(1)
      }
    } else {
      console.log(`__SUITE_SKIPPED browser: ${first.note}`)
      console.log('  – no drivable browser on this machine — SKIP (point MERCURY_BROWSER_CACHE_DIR at a managed Chrome-for-Testing cache to run)')
      process.exit(0)
    }
  }
  const r = resolveBrowser()
  console.log(`  driving: ${r.state === 'ok' ? `${r.source} — ${r.executablePath}` : r.note}`)
}

const ctx = {} as Parameters<typeof BrowserTool.call>[1]
async function run(input: ToolInput): Promise<{ result: string; outcome: string }> {
  const { data } = await BrowserTool.call(input, ctx)
  return { result: data.result, outcome: data.outcome }
}
function page() {
  const s = activeSession(OWNER)
  if (!s) throw new Error('no live session where one was expected')
  return s.page
}

type Served = { port: number; server: http.Server }
function serve(port: number, routes: (url: string, res: http.ServerResponse) => void): Promise<Served> {
  const server = http.createServer((req, res) => routes(req.url ?? '/', res))
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }))
  })
}
async function kill(served: Served): Promise<void> {
  served.server.closeAllConnections()
  await new Promise<void>(resolve => served.server.close(() => resolve()))
}
const html = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
const routes = (url: string, res: http.ServerResponse): void => {
  if (url === '/two') return html(res, 200, '<title>truth-two</title><body><p>the second page</p></body>')
  if (url === '/five') return html(res, 500, '<title>truth-five</title><body><p>the server fell over</p></body>')
  return html(res, 200, '<title>truth-one</title><body><h1>Truth One</h1><p>the first page</p></body>')
}

let a = await serve(0, routes)
const PORT = a.port
const A = `http://127.0.0.1:${PORT}`

console.log('§1 a reload after the server died is a failure in words, not a page')
{
  const opened = await run({ op: 'open', url: `${A}/` })
  check('the page opens while the server is up', opened.outcome === 'succeeded' && opened.result.includes('truth-one'), opened.result)
  await kill(a)
  const reload = await run({ op: 'reload' })
  check('reload FAILS (outcome failed) when the server is gone', reload.outcome === 'failed', `${reload.outcome} · ${reload.result}`)
  check('the reload names the network error', /ERR_CONNECTION_REFUSED/.test(reload.result), reload.result)
  check('the reload names the page it tried to reload', reload.result.includes(`${A}/`), reload.result)
  check("the reload says the browser shows its own error page, not the site", /own error page/.test(reload.result) && /not the site/.test(reload.result), reload.result)
  check('the reload never reads as a success line', !/^reload: /.test(reload.result), reload.result)

  const info = await run({ op: 'info' })
  check('info on the error page says what it is and why', /own error page/.test(info.result) && /ERR_CONNECTION_REFUSED/.test(info.result) && info.result.includes(`${A}/`), info.result)
  const extract = await run({ op: 'extract', mode: 'text' })
  check('extract on the error page names it in the header', /own error page/.test(extract.result.split('\n')[0] ?? ''), extract.result.split('\n')[0] ?? '')
  const shot = await run({ op: 'screenshot', label: 'truth-error-page' })
  check('a screenshot of the error page names it', shot.outcome === 'succeeded' && /own error page/.test(shot.result), shot.result)
  const click = await run({ op: 'click', selector: 'text/Reload', timeoutMs: 3000 })
  check("a click on the error page's own Reload button says where it landed", /own error page/.test(click.result), click.result)
  await run({ op: 'waitFor', timeoutMs: 3000 })
}

console.log('§2 the server comes back: reload is the ordinary success again')
{
  a = await serve(PORT, routes)
  const reload = await run({ op: 'reload' })
  check('reload succeeds once the server answers again', reload.outcome === 'succeeded' && reload.result.startsWith('reload: ') && reload.result.includes('[200]') && reload.result.includes('truth-one'), reload.result)
  const info = await run({ op: 'info' })
  check('info is back to the plain origin line', !/own error page/.test(info.result) && info.result.includes('(approved this session)'), info.result)
  check('the page title is the site again', (await page().title()) === 'truth-one')
}

console.log('§3 a 5xx stays a page with its status in words')
{
  const five = await run({ op: 'open', url: `${A}/five` })
  check('open names HTTP 500 in words', five.result.includes('HTTP 500'), five.result)
  const reload = await run({ op: 'reload' })
  check('reload names HTTP 500 in words', reload.result.includes('HTTP 500') && reload.result.includes('truth-five'), reload.result)
}

console.log('§4 back onto a dead server is the same failure')
{
  await run({ op: 'open', url: `${A}/` })
  await run({ op: 'open', url: `${A}/two` })
  await kill(a)
  const back = await run({ op: 'back' })
  check('back FAILS (outcome failed) when the earlier page cannot load', back.outcome === 'failed', `${back.outcome} · ${back.result}`)
  check('the back names the network error and the page', /ERR_CONNECTION_REFUSED/.test(back.result) && back.result.includes(`${A}/`), back.result)
  check('the back says the browser shows its own error page', /own error page/.test(back.result), back.result)
  const open = await run({ op: 'open', url: `${A}/two` })
  check('open on the dead server is the failure it always was', open.outcome === 'failed' && /ERR_CONNECTION_REFUSED/.test(open.result), open.result)
}

console.log("§4b a back onto a page the browser kept (no no-store header) is a success that says where the page came from")
{
  const plain = (res: http.ServerResponse, body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  const c = await serve(0, (url, res) => (url === '/b.html' ? plain(res, '<!doctype html><title>Page B</title><h1>Page B</h1>') : plain(res, '<!doctype html><title>Page A</title><h1>Page A</h1>')))
  const C = `http://127.0.0.1:${c.port}`
  const first = await run({ op: 'open', url: `${C}/a.html` })
  check('the cacheable page opens while its server is up', first.outcome === 'succeeded' && first.result.includes('Page A'), first.result)
  await run({ op: 'open', url: `${C}/b.html` })
  await kill(c)
  const back = await run({ op: 'back' })
  check('back succeeds — the page IS on screen', back.outcome === 'succeeded', `${back.outcome} · ${back.result}`)
  check("the line names the page and says it came from the browser's cache without asking the server", back.result.startsWith(`back: ${C}/a.html`) && back.result.includes('— Page A') && /the browser's cache; the server was not asked/.test(back.result), back.result)
  check('a status appears only when a response was read, and then the cache words still say the server was not asked', !/\[\d{3}\]/.test(back.result) || /served from the browser's cache/.test(back.result), back.result)
  check("the browser's own copy is the page", (await page().title()) === 'Page A' && page().url() === `${C}/a.html`)
  const reload = await run({ op: 'reload' })
  check('the control: a reload of that page asks the server and fails honestly (the server really is gone)', reload.outcome === 'failed' && /ERR_CONNECTION_REFUSED/.test(reload.result), reload.result)
}

console.log('§5 a link the session refuses as a download is named: type, size, filename, and what to use instead')
const d = await serve(0, (url, res) => {
  if (url === '/dl.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '13' })
    return res.end('payload-bytes')
  }
  if (url === '/attach.txt') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' })
    return res.end('hello notes')
  }
  if (url === '/slow.bin') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('slow-bytes')
    }, 600)
    return
  }
  if (url === '/two') return html(res, 200, '<title>download-two</title><body><p>the second page</p></body>')
  if (url === '/pop') return html(res, 200, '<title>popped</title><body><p>the popped page</p></body>')
  return html(
    res,
    200,
    `<title>download-fixture</title><body><h1>Downloads</h1>
<a id="dl" href="/dl.bin">Get data.bin (octet-stream)</a>
<a id="att" href="/attach.txt">attachment header</a>
<a id="dla" href="/dl.bin" download="named.bin">download attribute</a>
<a id="slow" href="/slow.bin">slow download</a>
<a id="two" href="/two">an ordinary link</a>
<button id="js" onclick="location.href='/dl.bin'">Script download</button>
<button id="pop" onclick="window.open('/pop', '_blank')">new tab</button>
<button id="alert-now" onclick="alert('ALERT-MARKER-77')">alert</button>
<button id="confirm-now" onclick="document.getElementById('seen').textContent = confirm('Delete it?') ? 'yes' : 'no'">confirm</button>
<p id="seen"></p>
</body>`,
  )
})
const D = `http://127.0.0.1:${d.port}`
const NOT_FOLLOWED = 'downloads are not followed here; fetch the file with WebFetch or Bash instead'
{
  const opened = await run({ op: 'open', url: `${D}/` })
  check('the download fixture opens', opened.outcome === 'succeeded' && opened.result.includes('download-fixture'), opened.result)
  const link = await run({ op: 'click', selector: 'aria/Get data.bin (octet-stream)[role="link"]' })
  check('a click on a link the server serves as a download says so in the result', link.result.includes('the link is a download'), link.result)
  check('…naming the type, the size and the filename', link.result.includes('application/octet-stream') && link.result.includes('13 bytes') && link.result.includes('saves as dl.bin'), link.result)
  check('…and what to use instead', link.result.includes(NOT_FOLLOWED), link.result)
  check('the page itself did not move', (await page().url()) === `${D}/`, await page().url())
  const attach = await run({ op: 'click', selector: '#att' })
  check('a Content-Disposition attachment is named with its filename', attach.result.includes('the link is a download') && attach.result.includes('text/plain') && attach.result.includes('11 bytes') && attach.result.includes('saves as notes.txt'), attach.result)
  const attr = await run({ op: 'click', selector: '#dla' })
  check('a download-attribute link (no network request of its own) is named too', attr.result.includes('the link is a download') && attr.result.includes('saves as named.bin') && attr.result.includes(NOT_FOLLOWED), attr.result)
  const script = await run({ op: 'click', selector: '#js' })
  check('a script-started download is named', script.result.includes('is a download') && script.result.includes('dl.bin'), script.result)
  const slow = await run({ op: 'click', selector: '#slow' })
  check('a slow download (the server answers 600ms later) is still named — the act waits for the navigation it started', slow.result.includes('the link is a download') && slow.result.includes('saves as slow.bin'), slow.result)
  const direct = await run({ op: 'open', url: `${D}/dl.bin` })
  check('open on a download URL fails naming the download, not a bare protocol error', direct.outcome === 'failed' && direct.result.includes(`open failed: ${D}/dl.bin is a download`) && direct.result.includes('application/octet-stream') && direct.result.includes('13 bytes') && direct.result.includes(NOT_FOLLOWED), direct.result)
  const ring = await run({ op: 'console', limit: 60 })
  check('the console ring carries the refused download by name', /download: the page asked to download dl\.bin/.test(ring.result) && /denied: downloads are not followed here/.test(ring.result), ring.result.split('\n').slice(-6).join(' | '))
  const ordinary = await run({ op: 'click', selector: '#two' })
  check('an ordinary link click reports the navigation it caused, with no download note', ordinary.result.includes(`navigated to ${D}/two`) && !ordinary.result.includes('download'), ordinary.result)
}

console.log('§6 a click that opens a tab or a dialog says so in its own result')
{
  await run({ op: 'open', url: `${D}/` })
  const pop = await run({ op: 'click', selector: '#pop' })
  check('a window.open click names the new tab in the click result', pop.result.includes('note: the page opened a new tab') && pop.result.includes(`${D}/pop`), pop.result)
  const alertNow = await run({ op: 'click', selector: '#alert-now' })
  check('an alert raised by the click is named in the click result', alertNow.result.includes('note: the page opened a dialog') && alertNow.result.includes('alert("ALERT-MARKER-77") auto-dismissed'), alertNow.result)
  const confirmNow = await run({ op: 'click', selector: '#confirm-now' })
  check('a confirm raised by the click is named with the answer the page received', confirmNow.result.includes('confirm("Delete it?") auto-dismissed (the page received false)'), confirmNow.result)
  check('…and the page did receive false', (await page().$eval('#seen', el => el.textContent)) === 'no')
}

await kill(d)
await run({ op: 'close' })

console.log("§7 a process that leaves with the browser open takes the browser's temp profile with it")
{
  const { execFileSync } = await import('node:child_process')
  const { existsSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const scratch = mkdtempSync(join(tmpdir(), 'browser-exit-drill-'))
  const drill = join(scratch, 'drill.ts')
  writeFileSync(
    drill,
    [
      `process.env.MERCURY_BROWSER ??= '1'`,
      `const { ensureBrowserSession } = await import(${JSON.stringify(join(ROOT, 'src/services/browser/browserSession.ts'))})`,
      `const { processOwnerForLane } = await import(${JSON.stringify(join(ROOT, 'src/services/run/resolveOwner.ts'))})`,
      `const s = await ensureBrowserSession(processOwnerForLane(null))`,
      `if ('state' in s) { console.log('NO-SESSION ' + s.note); process.exit(3) }`,
      `await s.page.goto(${JSON.stringify(`${A}/`)}).catch(() => undefined)`,
      `const dirArg = (s.browser.process()?.spawnargs ?? []).find(a => a.startsWith('--user-data-dir='))`,
      `console.log('PROFILE ' + (dirArg ? dirArg.slice('--user-data-dir='.length) : '(none)'))`,
      `process.exit(0)`,
    ].join('\n'),
  )
  let out = ''
  try {
    out = execFileSync(process.execPath, [drill], { encoding: 'utf8', env: process.env, timeout: 60_000 })
  } catch (err) {
    out = `${(err as { stdout?: string }).stdout ?? ''}\nDRILL FAILED: ${(err as Error).message}`
  }
  const profile = /PROFILE (.+)/.exec(out)?.[1] ?? ''
  check('the drill opened a session on a temp profile of its own', profile.startsWith('/') && /puppeteer_dev_[a-z]+_profile-/.test(profile), out.trim().slice(-300))
  if (profile.startsWith('/')) {
    const t0 = Date.now()
    while (existsSync(profile) && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 50))
    check('the temp profile folder is gone after the process exit (no Local State left behind)', !existsSync(profile), `${profile} still exists`)
  }
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error(`browser navigation truth: ${failures} FAILURES`)
  process.exit(1)
}
console.log('prove-browser-navigation-truth: ALL LAWS HOLD')
