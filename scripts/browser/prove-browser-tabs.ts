#!/usr/bin/env bun
import type http from 'node:http'
import { BrowserTool, check, detect, detectionHtml, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions, validate } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const handler =
  (other: string) =>
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (url.pathname === '/detect') {
      res.end(detectionHtml(req.headers, hostTz))
      return
    }
    if (url.pathname === '/framed') {
      res.end('<title>framed</title><button id="inner" onclick="document.title=\'inner clicked\'">inner</button>')
      return
    }
    if (url.pathname === '/frames') {
      res.end(`<title>frames</title><p>outer</p><iframe id="one" src="${other}/framed"></iframe>`)
      return
    }
    if (url.pathname === '/embeds') {
      res.end('<title>embeds</title><p>outer</p><iframe id="one" src="http://127.0.0.1:27289/framed"></iframe>')
      return
    }
    const name = url.pathname.slice(1) || 'root'
    res.end(
      `<!doctype html><title>${name}</title><input id="field"><button id="log" onclick="console.log('${name} logged ' + document.getElementById('field').value)">log</button><a id="next" href="/two">next</a><p id="ua"></p><script>document.getElementById('ua').textContent = navigator.userAgent; localStorage.setItem('seen-' + location.pathname, '1')</script>`,
    )
  }
const A = await serve(27287, handler('http://127.0.0.1:27288'))
const B = await serve(27288, handler('http://127.0.0.1:27287'))
const C = await serve(27289, handler('http://127.0.0.1:27287'))

type Ctx = typeof lead
const second: Ctx = { agentId: 'tabs-second-owner' }
const childOne: Ctx = { agentId: 'tabs-child-one' }
const childTwo: Ctx = { agentId: 'tabs-child-two' }
const leased: Ctx = { agentId: 'tabs-leased' }
const everyone = [lead, second, childOne, childTwo, leased]

const tabOf = (ctx: Ctx, tab?: string) => sessions.activeSession(ownerOf(ctx), tab) as ReturnType<typeof sessions.activeSession>
const names = (ctx: Ctx): string[] => ((sessions.browserTabs?.(ownerOf(ctx)) ?? []) as Array<{ tab: string }>).map(live => live.tab)
const pidOf = (ctx: Ctx, tab?: string): number | undefined => tabOf(ctx, tab)?.browser.process()?.pid
const fieldOf = (ctx: Ctx, tab?: string): Promise<string> =>
  pageOf(ctx, tab)
    .$eval('#field', el => (el as HTMLInputElement).value)
    .catch((err: Error) => `unreadable: ${err.message}`)
const first = (answer: { result: string }): string => answer.result.split('\n')[0] ?? ''
const pagesIn = async (ctx: Ctx, tab: string): Promise<number> => (await tabOf(ctx, tab)?.browser.pages())?.length ?? -1

section('S0 control: the unnamed page is today’s (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/form` })
  check('open without a tab answers in today’s words', opened.outcome === 'succeeded' && first(opened).startsWith(`open: ${A.origin}/form [200] — form (`), opened.result)
  const status = await run({ op: 'status' })
  check('status with one page reads as today', status.result.includes(`session: OPEN at ${A.origin}/form (viewport 1280x800)`), status.result)
  const typed = await run({ op: 'type', selector: '#field', text: 'alpha' })
  check('an act without a tab lands on that page', typed.outcome === 'succeeded' && (await fieldOf(lead)) === 'alpha', typed.result)
}

section('S1 two names at two origins keep their own page, history and console')
{
  const pidMain = pidOf(lead)
  const opened = await run({ op: 'open', tab: 'docs', url: `${B.origin}/form` })
  check('[M01] open with a new name opens another page and names it', opened.outcome === 'succeeded' && first(opened).startsWith(`[docs] open: ${B.origin}/form [200] — form (`), opened.result)
  check('[T6][M05] opening another origin under another name does not rotate the first page away', pidOf(lead) === pidMain && pageOf(lead).url() === `${A.origin}/form` && (await fieldOf(lead)) === 'alpha', `${pidOf(lead)} ${pageOf(lead).url()} ${await fieldOf(lead)}`)
  check('[T6] the second origin has its own browser', typeof pidOf(lead, 'docs') === 'number' && pidOf(lead, 'docs') !== pidMain, `${pidMain} ${pidOf(lead, 'docs')}`)
  const typed = await run({ op: 'type', tab: 'docs', selector: '#field', text: 'beta' })
  check('[M02] an act with a name lands on that tab and says so', typed.outcome === 'succeeded' && first(typed).startsWith('[docs] type: 4 chars into input#field') && (await fieldOf(lead, 'docs')) === 'beta' && (await fieldOf(lead)) === 'alpha', `${typed.result} · docs=${await fieldOf(lead, 'docs')} main=${await fieldOf(lead)}`)
  await run({ op: 'click', selector: '#log' })
  await run({ op: 'click', tab: 'docs', selector: '#log' })
  const ringMain = await run({ op: 'console' })
  const ringDocs = await run({ op: 'console', tab: 'docs' })
  check('[M02][M05] each tab has its own console ring', ringMain.result.includes('form logged alpha') && !ringMain.result.includes('form logged beta') && ringDocs.result.includes('form logged beta') && !ringDocs.result.includes('form logged alpha'), `${ringMain.result.split('\n').slice(-2).join(' | ')} ·· ${ringDocs.result.split('\n').slice(-2).join(' | ')}`)
  const moved = await run({ op: 'click', tab: 'docs', selector: '#next' })
  const back = await run({ op: 'back', tab: 'docs' })
  check('[M02][M05] history is the tab’s own: docs goes on and back, main never moved', moved.result.includes(`navigated to ${B.origin}/two`) && first(back).startsWith(`[docs] back: ${B.origin}/form`) && pageOf(lead).url() === `${A.origin}/form` && (await fieldOf(lead)) === 'alpha', `${moved.result} | ${back.result}`)
  const info = await run({ op: 'info', tab: 'docs' })
  const shot = await run({ op: 'screenshot', tab: 'docs', label: 'tabs-docs' })
  const sized = await run({ op: 'viewport', tab: 'docs', width: 900, height: 600 })
  const extracted = await run({ op: 'extract', tab: 'docs', selector: '#log' })
  check('[M02] info, screenshot, viewport and extract address the named tab', info.result.includes(`url: ${B.origin}/form`) && shot.outcome === 'succeeded' && shot.result.includes(`${B.origin}/form`) && first(sized).startsWith('[docs] viewport: 900x600') && pageOf(lead).viewport()?.width === 1280 && extracted.result.includes(`at ${B.origin}/form`), `${info.result} | ${shot.result} | ${sized.result} | ${first(extracted)}`)
  const plain = await run({ op: 'info' })
  check('[M02] an omitted name is main, whichever tab ran last', plain.result.startsWith(`url: ${A.origin}/form`), plain.result)
  const sibling = await run({ op: 'open', tab: 'notes', url: `${B.origin}/other` })
  const sharedBrowser = pidOf(lead, 'notes') === pidOf(lead, 'docs')
  const sharedStore = await pageOf(lead, 'notes').evaluate(() => localStorage.getItem('seen-/form'))
  check('[T6] a second tab at one origin lives in that origin’s browser and shares its storage', sibling.outcome === 'succeeded' && sharedBrowser && sharedStore === '1' && (await tabOf(lead, 'docs')!.browser.pages()).length === 2, `${sibling.result} shared=${sharedBrowser} store=${sharedStore}`)
  check('[M05] and the tab beside it kept its form value', (await fieldOf(lead, 'docs')) === 'beta')
}

section('S2 status lists the tabs')
{
  const status = await run({ op: 'status' })
  const lines = status.result.split('\n')
  const at = lines.findIndex(line => line.startsWith('session: OPEN'))
  check('[T2][M03] with more than main, status lists name, address, title and state', lines[at] === 'session: OPEN — 3 tabs' && lines[at + 1] === `  main: ${A.origin}/form — form (page 1; viewport 1280x800; idle lease)` && lines[at + 2] === `  docs: ${B.origin}/form — form (page 2; viewport 900x600; idle lease)` && lines[at + 3] === `  notes: ${B.origin}/other — other (page 3; viewport 1280x800; idle lease)`, lines.slice(at, at + 4).join(' | '))
  const paged = await run({ op: 'status', limit: 2 })
  const rest = await run({ op: 'status', offset: 2 })
  check('[M03] a list that is cut says how to continue, and the continuation shows the rest', paged.result.includes('  … 1 more — continue with offset: 2') && !paged.result.includes('  notes: ') && rest.result.includes('session: OPEN — 3 tabs, from 2') && rest.result.includes('  notes: ') && !rest.result.includes('  main: '), `${paged.result} || ${rest.result}`)
}

section('S3 close with a tab')
{
  const closed = await run({ op: 'close', tab: 'notes' })
  check('[T3][M04] close with a name closes that tab alone', closed.outcome === 'succeeded' && closed.result === 'tab notes closed — open: main, docs' && tabOf(lead, 'notes') === null && (await tabOf(lead, 'docs')!.browser.pages()).length === 1 && (await fieldOf(lead, 'docs')) === 'beta', closed.result)
  const absent = await run({ op: 'close', tab: 'nope' })
  check('[M04] closing a name that is not open says so and changes nothing', absent.outcome === 'no-change' && absent.result === 'no tab nope — open: main, docs' && names(lead).join(',') === 'main,docs', absent.result)
  const acted = await run({ op: 'click', tab: 'notes', selector: '#log' })
  check('[M02] an act on a closed name names it and the tabs that are open', acted.outcome === 'failed' && acted.result === 'no tab notes — op:"open" with tab:"notes" opens it; open: main, docs', acted.result)
  check('[M12] origin approvals stay while a tab remains', sessions.originApproved(ownerOf(lead), A.origin) && sessions.originApproved(ownerOf(lead), B.origin))
}

section('S4 approvals hold across tabs; a check belongs to the page and frame it saw')
{
  const allowed = await permission({ op: 'click', tab: 'docs', selector: '#log' })
  const another = await permission({ op: 'open', tab: 'third', url: `${B.origin}/form` })
  check('[T7][M12] an approved origin asks nothing under another name', allowed.behavior === 'allow' && another.behavior === 'allow', JSON.stringify([allowed, another]))
  await permission({ op: 'click', tab: 'docs', selector: '#log' })
  await run({ op: 'close', tab: 'docs' })
  await run({ op: 'open', tab: 'docs', url: `${B.origin}/form` })
  const stale = await run({ op: 'click', tab: 'docs', selector: '#log' })
  const ring = await run({ op: 'console', tab: 'docs' })
  check('[T7][B03] a check made for a page does not land on the page that took its name', stale.outcome === 'failed' && stale.result === 'click refused: tab docs holds another page than the one the permission check saw — nothing done; re-issue to act on the page that is there now' && !ring.result.includes('form logged'), `${stale.result} | ${ring.result.split('\n').slice(-1)[0]}`)
  await permission({ op: 'click', tab: 'docs', selector: '#log' })
  const reissued = await run({ op: 'click', tab: 'docs', selector: '#log' })
  check('[T7] issued again, the act is checked for the new page and lands', reissued.outcome === 'succeeded', reissued.result)
  await run({ op: 'open', tab: 'docs', url: `${B.origin}/embeds` })
  await pageOf(lead, 'docs').waitForSelector('iframe')
  const frameAsk = await permission({ op: 'click', tab: 'docs', frame: 1, selector: '#inner' })
  await pageOf(lead, 'docs').evaluate(() => {
    const old = document.getElementById('one') as HTMLIFrameElement
    const fresh = document.createElement('iframe')
    fresh.id = 'two'
    fresh.src = old.src
    old.replaceWith(fresh)
    return new Promise(done => fresh.addEventListener('load', () => done(null)))
  })
  const swapped = await run({ op: 'click', tab: 'docs', frame: 1, selector: '#inner' })
  check('[T7][B03] nor on a frame that replaced the frame the check saw', frameAsk.behavior === 'ask' && swapped.outcome === 'failed' && swapped.result === '[docs] click refused: the frame is another one than the permission check saw — nothing done; re-issue to act on the frame that is there now', `${JSON.stringify(frameAsk)} | ${swapped.result}`)
  check('[T7] the ask for an act in a tab names the tab', (frameAsk.message ?? '') === `Browser click #inner on ${C.origin} in tab docs — reached by navigation, not yet approved this session`, frameAsk.message ?? '')
  await run({ op: 'open', tab: 'docs', url: `${B.origin}/form` })
}

section('S5 names are the agent’s own')
{
  const asked = await permission({ op: 'open', tab: 'docs', url: `${A.origin}/form` }, second)
  check('[B01][M12] another agent asks for an origin this one approved', asked.behavior === 'ask', JSON.stringify(asked))
  await run({ op: 'open', url: `${A.origin}/two` }, second)
  await run({ op: 'open', tab: 'docs', url: `${A.origin}/other` }, second)
  check('[B01] two agents use the same names for their own pages', pageOf(second).url() === `${A.origin}/two` && pageOf(second, 'docs').url() === `${A.origin}/other` && pageOf(lead).url() === `${A.origin}/form` && pageOf(lead, 'docs').url() === `${B.origin}/form`, `${pageOf(second).url()} ${pageOf(second, 'docs').url()} ${pageOf(lead).url()} ${pageOf(lead, 'docs').url()}`)
  const mine = await run({ op: 'status' })
  check('[B01] status lists only this agent’s tabs and counts the other session once', mine.result.includes('session: OPEN — 2 tabs') && !mine.result.includes(`${A.origin}/other`) && mine.result.includes('other live sessions: 1 ('), mine.result.split('\n').slice(-6).join(' | '))
  const closed = await run({ op: 'close', tab: 'docs' }, second)
  check('[B01][M04] closing a name closes this agent’s tab, not the other agent’s', closed.result === 'tab docs closed — open: main' && pageOf(lead, 'docs').url() === `${B.origin}/form` && (await fieldOf(lead)) === 'alpha', closed.result)
  const whole = await run({ op: 'close' }, second)
  check('[T3] close without a name still ends the whole session', whole.result === 'session closed (browser reaped; origin approvals wiped)' && names(second).length === 0 && names(lead).join(',') === 'main,docs', whole.result)
}

section('S6 a tab never counts against the session allowance')
{
  process.env.MERCURY_BROWSER_MAX_SESSIONS = '1'
  const one = await run({ op: 'open', url: `${A.origin}/form` }, childOne)
  const two = await run({ op: 'open', tab: 'docs', url: `${B.origin}/form` }, childOne)
  const three = await run({ op: 'open', tab: 'notes', url: `${B.origin}/other` }, childOne)
  const rows = (sessions.liveBrowserSessionCensus() as Array<{ owner: string }>).filter(row => row.owner === ownerOf(childOne))
  check('[M10][G4] with the allowance at one, a child opens three tabs in two browsers', one.outcome === 'succeeded' && two.outcome === 'succeeded' && three.outcome === 'succeeded' && names(childOne).join(',') === 'main,docs,notes' && pidOf(childOne) !== pidOf(childOne, 'docs'), `${first(one)} | ${first(two)} | ${first(three)}`)
  check('[M10][G4] and holds one place in the count', rows.length === 1, JSON.stringify(rows))
  const refused = await run({ op: 'open', url: `${A.origin}/form` }, childTwo)
  check('[G4] a second child is refused with the count one, as before', refused.outcome === 'failed' && refused.result.includes('browser session refused: 1 of 1 child browser sessions are live in this parent session (agent:tabs-child-one)'), refused.result)
  delete process.env.MERCURY_BROWSER_MAX_SESSIONS
  await run({ op: 'close' }, childOne)
}

section('S7 a blank tab, and a failed open')
{
  const grants = sessions.approvedOriginList(ownerOf(lead)).join(',')
  const blank = await run({ op: 'open', tab: 'blank' })
  check('[M01] open with a name and no url opens a blank tab and approves no origin', blank.outcome === 'succeeded' && first(blank).startsWith('open: tab blank is a blank page (') && pageOf(lead, 'blank').url() === 'about:blank' && sessions.approvedOriginList(ownerOf(lead)).join(',') === grants, blank.result)
  const again = await run({ op: 'open', tab: 'blank' })
  check('[M01] the same call on an open tab loads nothing', again.outcome === 'no-change' && again.result === 'open: tab blank stays at about:blank — no url, nothing was loaded', again.result)
  const noName = await validate({ op: 'open' })
  check('open with neither a url nor a name is refused as today', !noName.ok && noName.message === 'open requires an http(s) url — "" has no scheme', noName.message)
  const dead = await run({ op: 'open', tab: 'dead', url: 'http://127.0.0.1:27299/' })
  check('[M07] a failed open says what remains', dead.outcome === 'failed' && first(dead).startsWith('[dead] open failed: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:27299/') && dead.result.includes('\n  note: tab dead stays open at chrome-error://chromewebdata/'), dead.result)
  check('[M07] and the page it stays on is the tab’s own: its browser holds that page and no other', (await pagesIn(lead, 'dead')) === 1 && (await pagesIn(lead, 'blank')) === 1 && names(lead).join(',') === 'main,docs,blank,dead', `dead=${await pagesIn(lead, 'dead')} blank=${await pagesIn(lead, 'blank')} ${names(lead).join(',')}`)
  await run({ op: 'close', tab: 'dead' })
  await run({ op: 'close', tab: 'blank' })
}

section('S8 every new page is prepared as the first one is')
{
  const probe = await run({ op: 'open', tab: 'probe', url: `${A.origin}/detect` })
  check('a named tab opens beside main in the browser of its origin', probe.outcome === 'succeeded' && pidOf(lead, 'probe') === pidOf(lead), probe.result)
  const nine = await detect(lead, 'probe')
  check('[G5] the nine baseline assertions hold on a page born beside another', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
  await run({ op: 'open', tab: 'docs', url: `${B.origin}/detect` })
  const moved = await detect(lead, 'docs')
  check('[G5] and on a named tab in its own browser', moved.passed === 9 && moved.total === 9, JSON.stringify(moved.checks))
  const hover = await run({ op: 'hover', tab: 'probe', selector: '#hover-target' })
  const click = await run({ op: 'click', tab: 'probe', selector: '#click-target' })
  const typed = await run({ op: 'type', tab: 'probe', selector: '#type-target', text: 'steady human keys' })
  const tel = (await pageOf(lead, 'probe').evaluate(() => (window as unknown as { __telemetry: unknown }).__telemetry)) as {
    moves: Array<{ t: number }>
    hovered: boolean
    downAt: number
    upAt: number
    clicked: number
    keydowns: Array<{ t: number }>
    allTrusted: boolean
  }
  const before = tel.moves.filter(move => move.t <= tel.downAt)
  const gaps = tel.keydowns.slice(1).map((key, i) => key.t - tel.keydowns[i]!.t)
  check('[G5] input on a named tab is human-paced: a travelled pointer, a dwell, a hold, spaced keys, all trusted', hover.outcome === 'succeeded' && click.outcome === 'succeeded' && typed.outcome === 'succeeded' && before.length >= 12 && tel.downAt - (before[before.length - 1]?.t ?? 0) >= 12 && tel.upAt - tel.downAt >= 10 && tel.hovered && tel.clicked === 1 && tel.keydowns.length === 17 && Math.min(...gaps) >= 2 && tel.allTrusted, `${hover.result} | ${click.result} | ${typed.result} | moves=${before.length} keys=${tel.keydowns.length}`)
  const mainTyped = await run({ op: 'type', selector: '#field', text: '-more' })
  check('[M02] after work on other tabs, typing on main still takes focus and lands', mainTyped.outcome === 'succeeded' && (await fieldOf(lead)) === 'alpha-more', `${mainTyped.result} ${await fieldOf(lead)}`)
  await run({ op: 'close', tab: 'probe' })
}

section('S9 emulation belongs to one tab')
{
  await run({ op: 'open', tab: 'phone' })
  const set = await run({ op: 'viewport', tab: 'phone', emulation: { device: 'Pixel 5', timezone: 'Asia/Tokyo' } })
  const loaded = await run({ op: 'open', tab: 'phone', url: `${A.origin}/form` })
  const phoneUa = await pageOf(lead, 'phone').$eval('#ua', el => el.textContent ?? '')
  const mainUa = await pageOf(lead).evaluate(() => navigator.userAgent)
  const served = A.hits.filter(hit => (hit.url ?? '') === '/form').slice(-1)[0]?.headers['user-agent'] ?? ''
  check('emulation set on a blank tab is in force for its first address', set.outcome === 'succeeded' && loaded.outcome === 'succeeded' && loaded.result.includes('the emulation came with it before it loaded (device Pixel 5, timezone Asia/Tokyo)') && phoneUa.includes('Pixel 5') && served.includes('Pixel 5'), `${set.result} | ${loaded.result} | ${phoneUa}`)
  check('[M05] the tabs beside it keep the launch environment', !mainUa.includes('Pixel 5') && pageOf(lead).viewport()?.width === 1280 && (await pageOf(lead).evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) === hostTz, mainUa)
  const listed = await run({ op: 'status' })
  check('[M03] status names the device a tab holds', listed.result.includes(`  phone: ${A.origin}/form — form (page `) && listed.result.includes('; viewport 393x851; device Pixel 5; idle lease)'), listed.result.split('\n').filter(line => line.startsWith('  phone')).join(''))
  await run({ op: 'close', tab: 'phone' })
}

section('S10 the lease, and a tab kept past it')
{
  const timers = new Map<object, () => void>()
  const realTimeout = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 300_000) return realTimeout(fn, ms, ...args)
    const timer = { unref() { return timer } }
    timers.set(timer, fn)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: object) => {
    if (!timers.delete(timer)) realClear(timer as ReturnType<typeof setTimeout>)
  }) as typeof clearTimeout
  const expire = async (): Promise<void> => {
    for (const [timer, fire] of [...timers]) {
      timers.delete(timer)
      fire()
    }
    await new Promise(done => realTimeout(done, 300))
  }
  try {
    await run({ op: 'open', url: `${A.origin}/form` }, leased)
    const kept = await run({ op: 'open', tab: 'keep', url: `${B.origin}/form`, persist: true }, leased)
    check('[T5] open with persist says the tab is kept', kept.outcome === 'succeeded' && kept.result.includes('\n  note: tab keep is kept past the 5-minute idle lease, until op:"close" or the session ends'), kept.result)
    await run({ op: 'type', tab: 'keep', selector: '#field', text: 'kept' }, leased)
    const pid = pidOf(leased, 'keep')
    await expire()
    check('[T5][M11] the lease closes the tabs that were not kept and leaves the kept one with its page', tabOf(leased) === null && tabOf(leased, 'keep') !== null && pidOf(leased, 'keep') === pid && (await fieldOf(leased, 'keep')) === 'kept', `${names(leased).join(',')}`)
    check('[M12] the session goes on, so its approvals stay', sessions.originApproved(ownerOf(leased), A.origin) && sessions.originApproved(ownerOf(leased), B.origin))
    const gone = await run({ op: 'info' }, leased)
    check('[M11] a call on a tab the lease closed says so', gone.outcome === 'failed' && gone.result === 'tab main was closed after 5 minutes idle — op:"open" with tab:"main" opens it; open: keep', gone.result)
    const listed = await run({ op: 'status' }, leased)
    check('[M03] status shows the kept tab as kept', listed.result.includes('session: OPEN — 1 tab') && listed.result.includes(`  keep: ${B.origin}/form — form (page 2; viewport 1280x800; persist)`), listed.result.split('\n').filter(line => line.startsWith('  keep') || line.startsWith('session')).join(' | '))
    const released = await run({ op: 'open', tab: 'keep', persist: false }, leased)
    check('[T5] persist false gives the tab back to the lease', released.outcome === 'succeeded' && released.result.includes('\n  note: tab keep closes with the 5-minute idle lease again'), released.result)
    await expire()
    const after = await run({ op: 'info', tab: 'keep' }, leased)
    check('[T5][M12] with nothing kept the lease ends the session as today, approvals with it', names(leased).length === 0 && after.result === '[keep] the browser is gone (its process exited) — op:"open" starts a new one' && !sessions.originApproved(ownerOf(leased), B.origin), `${after.result} ${names(leased).join(',')}`)
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }
}

section('S11 the words and the definition')
{
  const stray = await validate({ op: 'click', selector: '#x', persist: true })
  const blankName = await validate({ op: 'open', tab: ' ', url: `${A.origin}/` })
  const named = await validate({ op: 'open', tab: 'fresh' })
  check('persist belongs to open, a name is a name, and open with a name needs no url', !stray.ok && stray.message === 'persist requires op open' && !blankName.ok && blankName.message === 'tab takes a name on one line with no space around it' && named.ok, `${stray.message} | ${blankName.message} | ${named.message}`)
  const shape = (BrowserTool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape
  check('the definition carries the two fields in a short clause each', shape.tab?.description === 'Named tab (default main)' && shape.persist?.description === 'open: no idle close', `${shape.tab?.description} | ${shape.persist?.description}`)
  const manual = await BrowserTool.prompt()
  check('the manual says what a tab is and how it is closed', manual.includes('tab picks the page an op uses: main unless named, a new name opens another, without url a blank one; persist keeps it past the idle lease.') && manual.includes('close ends the session, or with tab that tab alone') && manual.includes('session state and open tabs without launching'), manual)
  check('the short description is unmoved', BrowserTool.wireDescription?.() === 'Drive one isolated browser session per agent through the bundled driver. Returns page observations, action results and screenshots. Opening a new origin or first acting on a crossed-to origin asks; reads never ask. Grants belong to this agent and end with its session.')
}

section('S12 the end of the agent releases every tab')
{
  const pids = [pidOf(lead), pidOf(lead, 'docs')].filter((pid): pid is number => typeof pid === 'number')
  await sessions.disposeBrowserOwner(ownerOf(lead))
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  let left = pids.filter(alive)
  for (let waited = 0; left.length > 0 && waited < 40; waited++) {
    await new Promise(done => setTimeout(done, 100))
    left = pids.filter(alive)
  }
  check('[M04][M09] disposal closes every browser the agent held', pids.length === 2 && left.length === 0 && names(lead).length === 0, `pids=${pids.join(',')} left=${left.join(',')}`)
}

await finish('prove-browser-tabs', everyone)
