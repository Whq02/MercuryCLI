#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const leases = new Map<object, () => void>()
const realTimeout = globalThis.setTimeout
const realClear = globalThis.clearTimeout
globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
  if (ms !== 300_000) return realTimeout(fn, ms, ...args)
  const timer = { unref: () => timer }
  leases.set(timer, fn)
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: object) => {
  if (!leases.delete(timer)) realClear(timer as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout

const { ROOT, check, decide, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions, validate } = await import('./harness.ts')

await requireBrowser()
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

const framed = { origin: '' }
const page = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const name = new URL(req.url ?? '/', 'http://fixture').pathname.slice(1) || 'root'
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (name === 'embeds') {
    res.end(`<!doctype html><title>embeds</title><p>outer text of embeds</p><iframe id="inner" title="inner" src="${framed.origin}/framed"></iframe>`)
    return
  }
  res.end(
    `<!doctype html><title>${name}</title><p id="who">signed in as the owner of ${name}</p><button id="go" onclick="document.title='${name} clicked'">go</button><a id="blank" target="_blank" href="/popup">new tab</a><script>console.log('${name} loaded')</script>`,
  )
}
const A = await serve(0, page)
const B = await serve(0, page)
const C = await serve(0, page)
framed.origin = B.origin

type Ctx = typeof lead
const isolated: Ctx = { agentId: 'attach-isolated-owner' }
const names = (ctx: Ctx = lead): string[] => (sessions.browserTabs(ownerOf(ctx)) as Array<{ tab: string }>).map(live => live.tab)
const first = (answer: { result: string }): string => answer.result.split('\n')[0] ?? ''
const until = async (ok: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await new Promise(done => realTimeout(done, 50))
  }
  return ok()
}

const resolved = resolveBrowser() as { executablePath: string }
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-user-'))
const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank']
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox')
const user: ChildProcess = spawn(resolved.executablePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
const socket = await new Promise<string>((done, fail) => {
  let seen = ''
  const lapse = realTimeout(() => fail(new Error(`the fixture Chromium never printed its debugging address: ${seen.slice(-400)}`)), 30_000)
  user.stderr?.on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8')
    const hit = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
    if (hit === null) return
    realClear(lapse)
    done(hit[1]!)
  })
  user.once('exit', code => fail(new Error(`the fixture Chromium exited (${code}) before it listened: ${seen.slice(-400)}`)))
})
const port = Number(new URL(socket).port)
const direct = `http://127.0.0.1:${port}`

let connections = 0
const relay = net.createServer(client => {
  connections++
  const up = net.connect(port, '127.0.0.1')
  client.pipe(up)
  up.pipe(client)
  client.on('error', () => up.destroy())
  up.on('error', () => client.destroy())
  client.on('close', () => up.destroy())
  up.on('close', () => client.destroy())
})
await new Promise<void>(done => relay.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`

const shown = async (): Promise<string[]> =>
  ((await (await fetch(`${direct}/json/list`)).json()) as Array<{ type: string; url: string }>).filter(target => target.type === 'page').map(target => target.url)
for (const url of [`${A.origin}/inbox`, `${B.origin}/bank`, `${A.origin}/embeds`]) await fetch(`${direct}/json/new?${url}`, { method: 'PUT' })
await until(async () => (await shown()).filter(url => url.startsWith('http')).length === 3)
const tabAt = (answer: { result: string }, url: string): string => /^\s*(tab-\d+): /.exec(answer.result.split('\n').find(line => line.includes(`: ${url}`)) ?? '')?.[1] ?? 'tab-missing'

try {
  section('S1 an endpoint that is not on this machine is refused, and nothing is reached')
  {
    for (const far of ['http://192.168.1.20:9222', 'http://example.com:9222', 'ws://10.0.0.5:9222/devtools/browser/abc', 'http://[::1]:9222']) {
      const verdict = await validate({ op: 'attach', endpoint: far })
      const judged = await permission({ op: 'attach', endpoint: far })
      const ran = await run({ op: 'attach', endpoint: far })
      check(`${far} is refused with the reason`, !verdict.ok && verdict.message.includes('is not this machine') && verdict.message.includes('loopback only') && judged.behavior === 'deny' && ran.outcome === 'failed' && names().length === 0, `${verdict.message} | ${judged.behavior} | ${ran.result}`)
    }
    const scheme = await validate({ op: 'attach', endpoint: `https://127.0.0.1:${port}` })
    const portless = await validate({ op: 'attach', endpoint: 'http://127.0.0.1' })
    const pageSocket = await validate({ op: 'attach', endpoint: `ws://127.0.0.1:${port}/devtools/page/abc` })
    const missing = await validate({ op: 'attach' })
    const stray = await validate({ op: 'open', url: `${A.origin}/inbox`, endpoint })
    check('another scheme, a missing port, a page socket and a missing endpoint are refused in words', !scheme.ok && !portless.ok && !pageSocket.ok && !missing.ok && missing.message.startsWith('attach requires endpoint'), `${scheme.message} | ${portless.message} | ${pageSocket.message} | ${missing.message}`)
    check('endpoint belongs to attach alone', !stray.ok && stray.message === 'endpoint requires op attach', stray.message)
    check('both loopback spellings and the browser socket pass', (await validate({ op: 'attach', endpoint })).ok && (await validate({ op: 'attach', endpoint: `http://localhost:${port}` })).ok && (await validate({ op: 'attach', endpoint: socket })).ok)
  }

  section('S2 attach asks once, names the endpoint and what Mercury will see; a decline reads and lists nothing')
  {
    const asked = (await permission({ op: 'attach', endpoint })) as { behavior: string; message?: string; decisionReason?: { type?: string; operatorOnly?: boolean }; suggestions?: unknown[] }
    check('the ask names the endpoint and the titles and addresses of the open tabs', asked.behavior === 'ask' && asked.message === `Browser attach: ${endpoint} — Mercury will see the titles and addresses of that browser's open tabs`, JSON.stringify(asked))
    check('the ask is the operator’s own and offers no standing rule', asked.decisionReason?.type === 'safetyCheck' && asked.decisionReason.operatorOnly === true && (asked.suggestions ?? []).length === 0, JSON.stringify(asked))
    const ruled = await decide({ op: 'attach', endpoint }, { allow: ['Browser', `Browser(origin:${endpoint})`] })
    check('no allow rule answers it for the operator', ruled.behavior === 'ask' && ruled.decidedBy === 'safetyCheckAsk', JSON.stringify(ruled))
    const status = await run({ op: 'status' })
    check('declined: no connection was made to the endpoint', connections === 0, `connections ${connections}`)
    check('declined: no tab is listed and no title or address is read', names().length === 0 && status.result.includes('session: none') && !status.result.includes(A.origin) && !status.result.includes('inbox') && !status.result.includes('attached'), status.result)
  }

  section('S3 attach joins the browser the test started and lists its tabs')
  let tabA = ''
  let tabB = ''
  let tabE = ''
  {
    const joined = await run({ op: 'attach', endpoint })
    tabA = tabAt(joined, `${A.origin}/inbox`)
    tabB = tabAt(joined, `${B.origin}/bank`)
    tabE = tabAt(joined, `${A.origin}/embeds`)
    check('attach answers with the endpoint and the product', joined.outcome === 'succeeded' && /^attached: http:\/\/127\.0\.0\.1:\d+ \(.*Chrome\/\d+.*\) — 4 tabs$/.test(first(joined)), joined.result)
    check('each open tab is listed by name with its address and title', tabA.startsWith('tab-') && tabB.startsWith('tab-') && tabA !== tabB && joined.result.includes(`${tabA}: ${A.origin}/inbox — inbox`) && joined.result.includes(`${tabB}: ${B.origin}/bank — bank`), joined.result)
    check('the answer says every origin asks and that close detaches', joined.result.includes('every origin asks before its first read and its first act') && joined.result.includes('op:"close" detaches'), joined.result)
    check('the connection went to the endpoint', connections > 0 && names().length === 4, `connections ${connections} · ${names().join(',')}`)
    const status = await run({ op: 'status' })
    check('status names the attached browser, its tabs and the rule that holds there', status.result.includes(`attached: ${endpoint}`) && status.result.includes('session: OPEN — 4 tabs') && status.result.includes(`${tabA}: ${A.origin}/inbox — inbox`) && status.result.includes('every other origin asks before its first read and its first act') && !status.result.includes('read without asking'), status.result)
    const again = await permission({ op: 'attach', endpoint })
    const relisted = await run({ op: 'attach', endpoint })
    check('attach to the browser already joined asks nothing and lists the same tabs', again.behavior === 'allow' && relisted.outcome === 'succeeded' && names().length === 4, `${again.behavior} | ${relisted.result}`)
  }

  section('S4 in an attached browser every origin asks before its first read and before its first act')
  {
    const info = await permission({ op: 'info', tab: tabA })
    check('info and status stay within what the attach ask covered', info.behavior === 'allow' && (await permission({ op: 'status' })).behavior === 'allow', info.behavior)
    const read = (await permission({ op: 'extract', tab: tabA })) as { behavior: string; message?: string; suggestions?: unknown[]; decisionReason?: { type?: string; operatorOnly?: boolean } }
    check('the first read of an origin asks and names the origin and the tab', read.behavior === 'ask' && read.message === `Browser extract on ${A.origin} in tab ${tabA} — a tab of your attached browser, signed in as you; first read there, not yet approved this session`, JSON.stringify(read))
    check('that ask is the operator’s own and offers no standing rule', read.decisionReason?.type === 'safetyCheck' && read.decisionReason.operatorOnly === true && (read.suggestions ?? []).length === 0, JSON.stringify(read))
    const text = await run({ op: 'extract', tab: tabA })
    check('approved, the read answers', text.result.includes('signed in as the owner of inbox'), text.result)
    const after = await Promise.all([permission({ op: 'extract', tab: tabA }), permission({ op: 'screenshot', tab: tabA }), permission({ op: 'console', tab: tabA }), permission({ op: 'click', tab: tabA, selector: '#go' })])
    check('the grant holds for that origin: later reads and acts ask nothing', after.every(verdict => verdict.behavior === 'allow'), after.map(verdict => verdict.behavior).join(','))
    const tree = await run({ op: 'extract', tab: tabE, mode: 'tree' })
    const plain = await run({ op: 'extract', tab: tabE })
    const inner = await permission({ op: 'extract', tab: tabE, frame: 1 })
    check('a granted page is read without the frames it embeds from another origin', tree.result.includes('outer text of embeds') && plain.result.includes('outer text of embeds') && !tree.result.includes('signed in as the owner of framed') && !plain.result.includes('signed in as the owner of framed'), `${tree.result} | ${plain.result}`)
    check('and that frame asks for its own origin before it is read', inner.behavior === 'ask' && (inner.message ?? '').includes(`on ${B.origin} in tab ${tabE}`) && (inner.message ?? '').includes('first read there'), JSON.stringify(inner))
    const others = await Promise.all([
      permission({ op: 'extract', tab: tabB }),
      permission({ op: 'console', tab: tabB }),
      permission({ op: 'screenshot', tab: tabB }),
      permission({ op: 'waitFor', tab: tabB, text: 'bank' }),
      permission({ op: 'viewport', tab: tabB, width: 900, height: 600 }),
    ])
    check('another origin asks for itself before any read', others.every(verdict => verdict.behavior === 'ask' && (verdict.message ?? '').includes(`on ${B.origin} in tab ${tabB}`) && (verdict.message ?? '').includes('first read there')), others.map(verdict => `${verdict.behavior}: ${verdict.message}`).join(' | '))
    const act = await permission({ op: 'click', tab: tabB, selector: '#go' })
    check('and before its first act', act.behavior === 'ask' && act.message === `Browser click #go on ${B.origin} in tab ${tabB} — a tab of your attached browser, signed in as you; first act there, not yet approved this session`, JSON.stringify(act))
    const allowRule = await decide({ op: 'extract', tab: tabB }, { allow: [`Browser(origin:${B.origin})`] })
    const denyRule = await decide({ op: 'extract', tab: tabB }, { deny: [`Browser(origin:${B.origin})`] })
    check('an allow rule written for the isolated browser does not answer for the user’s own; a deny rule denies', allowRule.behavior === 'ask' && denyRule.behavior === 'deny', `${JSON.stringify(allowRule)} | ${JSON.stringify(denyRule)}`)
    await permission({ op: 'click', tab: tabB, selector: '#go' })
    const clicked = await run({ op: 'click', tab: tabB, selector: '#go' })
    check('approved, the act lands on the user’s tab', clicked.outcome === 'succeeded' && (await pageOf(lead, tabB).title()) === 'bank clicked', clicked.result)
    check('and the origin is granted for reads too', (await permission({ op: 'extract', tab: tabB })).behavior === 'allow')
    await pageOf(lead, tabA).goto(`${C.origin}/moved`)
    const crossed = await permission({ op: 'extract', tab: tabA })
    check('a granted tab that went to another origin asks again for that origin', crossed.behavior === 'ask' && (crossed.message ?? '').includes(`on ${C.origin} in tab ${tabA}`), JSON.stringify(crossed))
    await pageOf(lead, tabA).goto(`${A.origin}/inbox`)
    const stale = await run({ op: 'extract', tab: tabA })
    check('a read whose page moved between the ask and the read is refused', stale.outcome === 'failed' && stale.result.includes(`the page moved from ${C.origin} to ${A.origin}`) && !stale.result.includes('signed in as'), stale.result)
  }

  section('S5 the isolated browser reads and asks exactly as before')
  {
    const url = `${A.origin}/own`
    const ask = await permission({ op: 'open', url }, isolated)
    check('its first visit asks in today’s words and offers the origin rule', ask.behavior === 'ask' && ask.message === `Browser open: ${url} — first visit to ${A.origin} this session (drives a real headless browser)` && JSON.stringify(ask.suggestions ?? []).includes(`origin:${A.origin}`), JSON.stringify(ask))
    const opened = await run({ op: 'open', url }, isolated)
    check('it opens in its own browser', opened.outcome === 'succeeded' && first(opened).startsWith(`open: ${url} [200] — own (managed-cache: `), opened.result)
    const reads = await Promise.all([permission({ op: 'extract' }, isolated), permission({ op: 'console' }, isolated), permission({ op: 'screenshot' }, isolated), permission({ op: 'waitFor', text: 'own' }, isolated), permission({ op: 'viewport', width: 900, height: 600 }, isolated)])
    check('its reads never ask', reads.every(verdict => verdict.behavior === 'allow'), reads.map(verdict => verdict.behavior).join(','))
    await pageOf(isolated).goto(`${B.origin}/reached`)
    const crossing = await permission({ op: 'click', selector: '#go' }, isolated)
    check('its first act on a crossed-to origin asks in today’s words', crossing.behavior === 'ask' && crossing.message === `Browser click #go on ${B.origin} — reached by navigation, not yet approved this session`, JSON.stringify(crossing))
    const status = await run({ op: 'status' }, isolated)
    check('its status carries today’s rule line and no attached browser', status.result.includes('pages it links or redirects to are read without asking') && !status.result.includes('attached:'), status.result)
    const beside = await run({ op: 'attach', endpoint }, isolated)
    check('attach is refused while an isolated session is open', beside.outcome === 'failed' && beside.result.startsWith('attach failed: a browser session is open (main)'), beside.result)
    const closed = await run({ op: 'close' }, isolated)
    check('its close reaps its browser in today’s words', closed.result === 'session closed (browser reaped; origin approvals wiped)', closed.result)
  }

  section('S6 open adds a tab to the attached browser; a download is not followed there')
  {
    const url = `${C.origin}/mine`
    const ask = await permission({ op: 'open', url })
    check('opening a new origin asks and says where it opens', ask.behavior === 'ask' && ask.message === `Browser open: ${url} — first visit to ${C.origin} this session, in your attached browser (${endpoint}) and as you are signed in there`, JSON.stringify(ask))
    const opened = await run({ op: 'open', url })
    check('the tab opens in the attached browser', opened.outcome === 'succeeded' && first(opened) === `open: ${url} [200] — mine (attached: ${endpoint})` && (await shown()).includes(url) && names().includes('main'), `${opened.result} | ${(await shown()).join(',')}`)
    const download = await permission({ op: 'download', url: `${C.origin}/file` })
    check('download with a url is refused there, in words', download.behavior === 'deny' && (download.message ?? '').startsWith(`download refused: ${endpoint} is an attached browser and saves its downloads itself`), JSON.stringify(download))
  }

  section('S7 a tab that a page opens stays open in the user’s browser')
  {
    await permission({ op: 'click', tab: tabB, selector: '#blank' })
    const clicked = await run({ op: 'click', tab: tabB, selector: '#blank' })
    const kept = await until(async () => (await shown()).includes(`${B.origin}/popup`))
    await new Promise(done => realTimeout(done, 600))
    const status = await run({ op: 'status' })
    check('the new tab is not closed', clicked.outcome === 'succeeded' && kept && (await shown()).includes(`${B.origin}/popup`), `${clicked.result} | ${(await shown()).join(',')}`)
    check('and status lists it as a tab of that browser', new RegExp(`tab-\\d+: ${B.origin.replace(/[.]/g, '\\.')}/popup — popup`).test(status.result), status.result)
  }

  section('S8 close with a tab lets a user’s tab go and closes a tab Mercury opened')
  {
    const released = await run({ op: 'close', tab: tabB })
    check('a tab the user opened is let go and stays open', released.outcome === 'succeeded' && first(released).startsWith(`tab ${tabB} let go: it stays open in its browser — open: `) && !names().includes(tabB) && (await shown()).some(url => url.startsWith(`${B.origin}/bank`)), `${released.result} | ${(await shown()).join(',')}`)
    await run({ op: 'open', tab: 'scratch', url: `${C.origin}/scratch` })
    const before = (await shown()).includes(`${C.origin}/scratch`)
    const closed = await run({ op: 'close', tab: 'scratch' })
    check('a tab Mercury opened there is closed', before && closed.outcome === 'succeeded' && first(closed).startsWith('tab scratch closed — open: ') && (await until(async () => !(await shown()).includes(`${C.origin}/scratch`))), `${closed.result} | ${(await shown()).join(',')}`)
  }

  section('S9 the idle lease detaches: the browser and the user’s tabs stay')
  {
    const before = await shown()
    for (const lapse of [...leases.values()]) lapse()
    const gone = await until(() => names().length === 0)
    const left = await until(async () => !(await shown()).includes(`${C.origin}/mine`))
    const after = await shown()
    check('after five idle minutes no tab is held', gone, names().join(','))
    check('the browser is alive with every tab its user had', user.exitCode === null && before.filter(url => !url.startsWith(C.origin) || url.endsWith('/moved')).every(url => after.includes(url)) && after.includes(`${A.origin}/inbox`) && after.some(url => url.startsWith(`${B.origin}/bank`)) && after.includes(`${B.origin}/popup`), `${before.join(',')} → ${after.join(',')}`)
    check('the tab Mercury opened there was closed', left, after.join(','))
    const next = await run({ op: 'info', tab: tabA })
    check('the next call says the session is over, not that the browser died', next.outcome === 'failed' && next.result.includes('no open session') && !next.result.includes('gone'), next.result)
  }

  section('S10 a new attach asks again, by the browser socket too, and earlier grants are gone')
  {
    const asked = await permission({ op: 'attach', endpoint: socket })
    check('the attach asks again', asked.behavior === 'ask' && asked.message === `Browser attach: ${socket} — Mercury will see the titles and addresses of that browser's open tabs`, JSON.stringify(asked))
    const joined = await run({ op: 'attach', endpoint: socket })
    tabA = tabAt(joined, `${A.origin}/inbox`)
    check('the browser socket attaches', joined.outcome === 'succeeded' && first(joined).startsWith(`attached: ${socket} (`) && tabA.startsWith('tab-'), joined.result)
    const read = await permission({ op: 'extract', tab: tabA })
    check('an origin granted in the earlier attach asks again', read.behavior === 'ask' && (read.message ?? '').includes(`on ${A.origin} in tab ${tabA}`), JSON.stringify(read))
  }

  section('S11 close detaches: it never closes the browser, a tab its user opened, or the profile')
  {
    await run({ op: 'open', url: `${C.origin}/last` })
    const before = await shown()
    const closed = await run({ op: 'close' })
    const after = await shown()
    check('close says it detached and what it closed', closed.outcome === 'succeeded' && closed.result === `detached from ${socket}: that browser and its user's tabs stay open; 1 tab opened here was closed (origin approvals wiped)`, closed.result)
    check('the browser process is alive and answers', user.exitCode === null && user.signalCode === null && after.length > 0, `exit ${user.exitCode}`)
    check('every tab its user opened is still open', before.filter(url => url !== `${C.origin}/last`).every(url => after.includes(url)) && after.includes(`${A.origin}/inbox`) && after.includes(`${B.origin}/popup`), `${before.join(',')} → ${after.join(',')}`)
    check('the tab Mercury opened is closed', !after.includes(`${C.origin}/last`), after.join(','))
    const status = await run({ op: 'status' })
    check('no session is left', names().length === 0 && status.result.includes('session: none') && !status.result.includes('attached:'), status.result)
    const again = await run({ op: 'close' })
    check('a second close has nothing to close', again.result === 'no open session', again.result)
  }

  section('S11b an agent that ends while attached leaves the browser as it found it')
  {
    const ending: Ctx = { agentId: 'attach-ending-owner' }
    const joined = await run({ op: 'attach', endpoint }, ending)
    await run({ op: 'open', url: `${C.origin}/ending` }, ending)
    const before = await shown()
    await sessions.disposeBrowserOwner(ownerOf(ending))
    const after = await shown()
    check('its teardown detaches and closes only its own tab', joined.outcome === 'succeeded' && before.includes(`${C.origin}/ending`) && user.exitCode === null && !after.includes(`${C.origin}/ending`) && before.filter(url => url !== `${C.origin}/ending`).every(url => after.includes(url)), `${before.join(',')} → ${after.join(',')}`)
  }

  section('S12 the user quits the browser, then nothing answers at the endpoint')
  {
    await run({ op: 'attach', endpoint })
    const held = names().length
    user.kill('SIGKILL')
    const dropped = await until(() => names().length === 0, 10_000)
    check('the tabs go with the browser', held > 0 && dropped, `${held} → ${names().join(',')}`)
    const dead = await run({ op: 'attach', endpoint: direct })
    check('an endpoint where nothing listens fails in words that say how to start one', dead.outcome === 'failed' && dead.result.startsWith(`attach failed: no browser answers at ${direct}`) && dead.result.includes('--remote-debugging-port=<port> and a --user-data-dir of its own'), dead.result)
  }
} finally {
  globalThis.setTimeout = realTimeout
  globalThis.clearTimeout = realClear
  if (user.exitCode === null) user.kill('SIGKILL')
  await new Promise<void>(done => relay.close(() => done()))
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
}

await finish('prove-browser-attach', [lead, isolated])
