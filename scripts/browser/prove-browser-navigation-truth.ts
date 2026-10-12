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

await run({ op: 'close' })
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error(`browser navigation truth: ${failures} FAILURES`)
  process.exit(1)
}
console.log('prove-browser-navigation-truth: ALL LAWS HOLD')
