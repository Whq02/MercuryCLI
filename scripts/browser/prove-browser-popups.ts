#!/usr/bin/env bun
import type http from 'node:http'
import { join } from 'node:path'
import { BrowserTool, ROOT, check, detect, detectionHtml, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
interface Seen {
  method: string
  path: string
  body: string
  brands: string
  mobile: string
  agent: string
  language: string
  cookie: string
}
const seen: Seen[] = []
const handler =
  (other: string) =>
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({
        method: req.method ?? '',
        path: url.pathname + url.search,
        body,
        brands: String(req.headers['sec-ch-ua'] ?? ''),
        mobile: String(req.headers['sec-ch-ua-mobile'] ?? ''),
        agent: String(req.headers['user-agent'] ?? ''),
        language: String(req.headers['accept-language'] ?? ''),
        cookie: String(req.headers.cookie ?? ''),
      })
      if (url.pathname === '/dl') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="payload.bin"' })
        res.end('0123456789')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(url.pathname === '/opener' ? { 'set-cookie': 'sid=popups-27291; Path=/' } : {}) })
      if (url.pathname === '/detect') {
        res.end(detectionHtml(req.headers, hostTz))
        return
      }
      if (url.pathname === '/closer') {
        res.end('<title>closer</title><script>setTimeout(() => window.close(), 500)</script>')
        return
      }
      if (url.pathname === '/opener') {
        res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>opener</title>
<input id="note">
<button id="plain" onclick="document.title='plain clicked'">plain</button>
<button id="pop" onclick="window.open('/popped?via=open', '_blank')">pop</button>
<a id="link" target="_blank" href="/popped?via=link">link</a>
<a id="cross" target="_blank" href="${other}/popped?via=cross">cross</a>
<a id="probe" target="_blank" href="/detect">probe</a>
<a id="dl" target="_blank" href="/dl">dl</a>
<button id="closer" onclick="window.open('/closer', '_blank')">closer</button>
<button id="late" onclick="setTimeout(() => window.open('/popped?via=late', '_blank'), 1500)">late</button>
<form id="f" target="_blank" method="post" action="/popped?via=form"><input id="q" name="q" value="posted-once"><button id="submit">go</button></form>`)
        return
      }
      res.end(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>popped ${req.method}</title><p id="method">${req.method}</p><p id="body">${body}</p><input id="field"><p id="opener"></p><script>document.getElementById('opener').textContent = window.opener ? 'opener: ' + window.opener.document.title : 'no opener'</script>`,
      )
    })
  }
const A = await serve(27291, handler('http://127.0.0.1:27292'))
const B = await serve(27292, handler('http://127.0.0.1:27291'))

type Ctx = typeof lead
const second: Ctx = { agentId: 'popups-second-owner' }
const names = (ctx: Ctx = lead): string[] => ((sessions.browserTabs?.(ownerOf(ctx)) ?? []) as Array<{ tab: string }>).map(live => live.tab)
const tabOf = (tab: string, ctx: Ctx = lead) => sessions.activeSession(ownerOf(ctx), tab) as ReturnType<typeof sessions.activeSession>
const textOf = (tab: string, selector: string): Promise<string> =>
  (tabOf(tab) === null ? Promise.reject(new Error(`no tab ${tab}`)) : pageOf(lead, tab).$eval(selector, el => el.textContent ?? '')).catch((err: Error) => `unreadable: ${err.message}`)
const inTab = async <T>(tab: string, read: (page: ReturnType<typeof pageOf>) => Promise<T>): Promise<T | string> =>
  tabOf(tab) === null ? `no tab ${tab}` : read(pageOf(lead, tab)).catch((err: Error) => `unreadable: ${err.message}`)
const firstOf = (needle: string): Seen | undefined => seen.find(hit => hit.path.includes(needle))
const count = (needle: string, method?: string): number => seen.filter(hit => hit.path.includes(needle) && (method === undefined || hit.method === method)).length
const armed = (hit: Seen | undefined): boolean => hit !== undefined && hit.brands.includes('Google Chrome') && hit.brands.includes('Chromium')
const keptNote = (answer: { result: string }, tab: string, where: string): boolean => answer.result.includes(`\n  note: the page opened a new tab — kept as tab ${tab} at ${where}`) && answer.result.includes(`; pass tab:"${tab}" to use it`)
const pagesOfMain = async (): Promise<number> => (await tabOf('main')!.browser.pages()).length

section('S0 control: an act that opens nothing (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/opener` })
  await run({ op: 'type', selector: '#note', text: 'opener state' })
  const plain = await run({ op: 'click', selector: '#plain' })
  check('a click that opens no tab answers as today, and the browser holds the one page', opened.outcome === 'succeeded' && plain.result === `click #plain at ${A.origin}/opener` && (await pagesOfMain()) === 1 && names().join(',') === 'main', `${plain.result} ${names().join(',')}`)
}

section('S1 a window the act opened is kept, with what only that window holds')
{
  const clicked = await run({ op: 'click', selector: '#pop' })
  check('[T4] the act’s answer names the tab and where it landed', clicked.outcome === 'succeeded' && keptNote(clicked, 'popup', `${A.origin}/popped?via=open`) && names().join(',') === 'main,popup', clicked.result)
  check('[B02] the kept tab still has its opener: the two windows reach each other', (await textOf('popup', '#opener')) === 'opener: plain clicked' && (await inTab('popup', page => page.evaluate(() => (window.opener as Window | null)?.document.getElementById('note') !== null))) === true, await textOf('popup', '#opener'))
  check('[G5] its first request carried the launch identity, brand list included', armed(firstOf('via=open')), JSON.stringify(firstOf('via=open')))
  const typed = await run({ op: 'type', tab: 'popup', selector: '#field', text: 'in the popup' })
  check('[T4] the kept tab takes acts by its name', typed.outcome === 'succeeded' && (await inTab('popup', page => page.$eval('#field', el => (el as HTMLInputElement).value))) === 'in the popup', typed.result)
  check('[T4] an approved origin asks nothing on the tab it opened', (await permission({ op: 'click', tab: 'popup', selector: '#field' })).behavior === 'allow')
  check('[M05] the opener kept its page', (await pageOf().$eval('#note', el => (el as HTMLInputElement).value)) === 'opener state' && pageOf().url() === `${A.origin}/opener`)
  const status = await run({ op: 'status' })
  check('[T2] status lists it', status.result.includes('session: OPEN — 2 tabs') && status.result.includes(`  popup: ${A.origin}/popped?via=open — popped GET (page 2; viewport 1280x800; idle lease)`), status.result.split('\n').filter(line => line.startsWith('  popup') || line.startsWith('session')).join(' | '))
  const ring = await run({ op: 'console' })
  check('the opener’s ring names the tab it became', ring.result.includes(`popup: the page opened a new tab: ${A.origin}/popped?… — kept as tab popup`), ring.result.split('\n').slice(-3).join(' | '))
}

section('S2 a tab born with its address already asked for')
{
  const linked = await run({ op: 'click', selector: '#link' })
  const hit = firstOf('via=link')
  check('[T4] a link that opens a tab is kept under the next name', keptNote(linked, 'popup-2', `${A.origin}/popped?via=link`) && names().join(',') === 'main,popup,popup-2', linked.result)
  check('[G5] its first request carries the launch brand list, not the browser’s own', armed(hit) && hit?.mobile === '?0', JSON.stringify(hit))
  check('and the cookie of its site', hit?.cookie.includes('sid=popups-27291') === true, hit?.cookie ?? '')
  const posted = await run({ op: 'click', selector: '#submit' })
  const form = firstOf('via=form')
  check('[B02] a form posted into a new tab is kept with the answer the post got, which its address alone would not give', keptNote(posted, 'popup-3', `${A.origin}/popped?via=form`) && (await textOf('popup-3', '#method')) === 'POST' && (await textOf('popup-3', '#body')) === 'q=posted-once', `${posted.result} | ${await textOf('popup-3', '#body')}`)
  check('[G5] the post went once, with its body and the launch brand list', count('via=form', 'POST') === 1 && form?.body === 'q=posted-once' && armed(form), JSON.stringify(form))
  const entered = await run({ op: 'type', selector: '#q', text: '-again', enter: true })
  await tabOf('popup-4')?.page.waitForSelector('#body', { timeout: 5000 }).catch(() => null)
  check('[T4] a tab that Enter opens is kept and named in that answer too', keptNote(entered, 'popup-4', `${A.origin}/popped?via=form`) && (await textOf('popup-4', '#body')) === 'q=-againposted-once', `${entered.result} | ${await textOf('popup-4', '#body')}`)
}

section('S3 no approval comes with a kept tab')
{
  const crossed = await run({ op: 'click', selector: '#cross' })
  check('[T4] a tab opened onto another origin is kept, and its answer says acts there will ask', keptNote(crossed, 'popup-5', `${B.origin}/popped?via=cross (its origin is not approved: acts there will ask)`), crossed.result)
  const asked = await permission({ op: 'click', tab: 'popup-5', selector: '#field' })
  check('[T4][B02] the first act on its origin asks exactly as a crossed-to origin asks', asked.behavior === 'ask' && asked.message === `Browser click #field on ${B.origin} in tab popup-5 — reached by navigation, not yet approved this session` && !sessions.originApproved(ownerOf(lead), B.origin), JSON.stringify(asked))
  const read = await run({ op: 'extract', tab: 'popup-5', selector: '#method' })
  check('reads on it ask nothing, as reads never do', read.outcome !== 'failed' && read.result.includes('GET'), read.result)
}

section('S4 the nine assertions on a kept tab')
{
  const probed = await run({ op: 'click', selector: '#probe' })
  check('a link into the detection page is kept', keptNote(probed, 'popup-6', `${A.origin}/detect`), probed.result)
  const nine = tabOf('popup-6') === null ? { passed: 0, total: 9, checks: {} } : await detect(lead, 'popup-6')
  check('[G5] all nine hold on the document it was born with, the request’s brand list among them', nine.passed === 9 && nine.total === 9, JSON.stringify(nine.checks))
}

section('S5 tabs the lane does not keep')
{
  const before = names().join(',')
  const pages = await pagesOfMain()
  const late = await run({ op: 'click', selector: '#late' })
  await new Promise(done => setTimeout(done, 2600))
  const ring = await run({ op: 'console' })
  check('[T4] a tab no act opened is closed unadopted, as before', late.result === `click #late at ${A.origin}/opener` && names().join(',') === before && (await pagesOfMain()) === pages && ring.result.includes(`popup: the page opened a new tab: ${A.origin}/popped?… — closed unadopted (no act opened it; op:"open" follows it)`), `${late.result} | ${names().join(',')} | ${ring.result.split('\n').slice(-2).join(' | ')}`)
  const download = await run({ op: 'click', selector: '#dl' })
  check('a new tab that is a download is not kept: the answer says it is a download, as a link in the page does', download.result.includes('\n  note: the link is a download (') && download.result.includes('saves as payload.bin) — downloads are not followed here; fetch the file with WebFetch or Bash instead') && names().join(',') === before && (await pagesOfMain()) === pages, `${download.result} | ${names().join(',')}`)
  const closer = await run({ op: 'click', selector: '#closer' })
  check('a tab that closes itself was kept while it lived', keptNote(closer, 'popup-7', `${A.origin}/closer`), closer.result)
  await new Promise(done => setTimeout(done, 1200))
  const gone = await run({ op: 'info', tab: 'popup-7' })
  check('[M08] and a call on it afterwards names how it ended', gone.outcome === 'failed' && gone.result.startsWith('tab popup-7 closed itself (window.close) — op:"open" with tab:"popup-7" opens it; open: main, popup, popup-2'), gone.result)
}

section('S6 the opener’s emulation comes with the tab')
{
  for (const tab of ['popup', 'popup-2', 'popup-3', 'popup-4', 'popup-5', 'popup-6']) await run({ op: 'close', tab })
  const set = await run({ op: 'viewport', emulation: { device: 'Pixel 5', timezone: 'Asia/Tokyo', locale: 'fr-FR' } })
  const mark = seen.length
  const linked = await run({ op: 'click', selector: '#link' })
  const hit = seen.slice(mark).find(entry => entry.path.includes('via=link'))
  check('the device is set on the opener', set.outcome === 'succeeded' && set.result.includes('device: Pixel 5'), set.result)
  check('[E6][G5] the tab’s first request is the phone’s: user agent, language and brand list of one identity', linked.outcome === 'succeeded' && hit !== undefined && hit.agent.includes('Pixel 5') && hit.language.startsWith('fr-FR') && hit.mobile === '?1' && armed(hit), JSON.stringify(hit))
  check('the answer says the emulation came with it', linked.result.includes('; the emulation came with it (device Pixel 5, timezone Asia/Tokyo, locale fr-FR), and it was reloaded for mobile or touch'), linked.result)
  const facts = await inTab('popup-8', page => page.evaluate(() => [navigator.userAgent.includes('Pixel 5'), innerWidth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language]))
  check('and the page is that phone: size, zone and language', JSON.stringify(facts) === '[true,393,"Asia/Tokyo","fr-FR"]', JSON.stringify(facts))
  const posts = count('via=form', 'POST')
  const posted = await run({ op: 'click', selector: '#submit' })
  check('a tab holding a form post’s answer is not reloaded for the phone’s size: the form went once', count('via=form', 'POST') === posts + 1 && (await textOf('popup-9', '#method')) === 'POST' && posted.result.includes('\n  note: tab popup-9: its size, mobile and touch did not come: this tab holds the answer to a form post, and applying them reloads the page, which would send the form again — op:"viewport" on this tab applies them when that is safe'), `${posted.result} posts=${count('via=form', 'POST') - posts}`)
  check('its identity still came at birth', seen.filter(entry => entry.path.includes('via=form')).slice(-1)[0]?.agent.includes('Pixel 5') === true && (await inTab('popup-9', page => page.evaluate(() => navigator.userAgent.includes('Pixel 5')))) === true)
  await run({ op: 'viewport', emulation: { reset: true } })
}

section('S7 names are the agent’s own, and the end')
{
  await run({ op: 'open', url: `${A.origin}/opener` }, second)
  const other = await run({ op: 'click', selector: '#pop' }, second)
  check('[B01] another agent’s first kept tab is its own popup', other.result.includes('kept as tab popup at') && names(second).join(',') === 'main,popup' && names().includes('popup-8') && !names().includes('popup'), `${other.result} | ${names(second).join(',')} | ${names().join(',')}`)
  const closed = await run({ op: 'close' })
  check('[T3] close without a name ends the session with every kept tab', closed.result.startsWith('session closed (browser reaped, 3 tabs: main, popup-8, popup-9; origin approvals wiped)') && names().length === 0 && names(second).length === 2, closed.result)
  const manual = await BrowserTool.prompt()
  check('the manual says a tab an act opens is kept', manual.includes('click checks actionability; a tab that an act opens is kept and named in the answer (popup, popup-2).') && !manual.includes('closed unadopted'), manual.split('\n').find((line: string) => line.startsWith('click')) ?? '')
}

section('S8 what watching for new tabs costs a launch')
{
  interface Sent {
    method: string
    params: { filter?: unknown } | undefined
    session: string | undefined
  }
  const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
  const send = Connection.prototype._rawSend
  let sent: Sent[] = []
  Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
    sent.push({ method: String(method), params: params as Sent['params'], session: typeof session === 'string' ? session : undefined })
    return send.call(this, callbacks, method, params, session, ...rest)
  }
  const launched = async (agentId: string, births: boolean): Promise<Sent[]> => {
    sent = []
    const owner = ownerOf({ agentId })
    await sessions.ensureBrowserSession(owner, { origin: B.origin, ...(births ? { births: true } : {}) })
    const commands = [...sent]
    await sessions.disposeBrowserOwner(owner)
    return commands
  }
  const watches = (commands: Sent[]): Sent[] => commands.filter(command => command.method === 'Target.setAutoAttach' && JSON.stringify(command.params?.filter) === '[{"type":"page","exclude":false}]')
  const attaches = (commands: Sent[]): number => commands.filter(command => command.method === 'Target.attachToTarget').length
  try {
    const plain = await launched('popups-count-plain', false)
    const watched = await launched('popups-count-watched', true)
    const watch = watches(watched)
    const onWatch = watched.filter(command => command.session !== undefined && command.session === watch[0]?.session).map(command => command.method)
    check('a launch that does not ask for the watch sends nothing for it', watches(plain).length === 0, `${watches(plain).length}`)
    check('a launch that watches sends three protocol commands for it: one attach to the browser, and on that session the auto-attach and the release of the page it already holds', watch.length === 1 && attaches(watched) === attaches(plain) + 1 && onWatch.join(',') === 'Target.setAutoAttach,Target.detachFromTarget', `attaches ${attaches(plain)} to ${attaches(watched)}; on the watch: ${onWatch.join(',')}`)
  } finally {
    Connection.prototype._rawSend = send
  }
}

await finish('prove-browser-popups', [lead, second])
