#!/usr/bin/env bun
import type http from 'node:http'
import { BrowserTool, check, detect, detectionHtml, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const A = await serve(27293, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/detect') {
    res.end(detectionHtml(req.headers, hostTz))
    return
  }
  const name = url.pathname.slice(1) || 'root'
  res.end(`<!doctype html><title>${name}</title><input id="field"><a id="next" href="/two">next</a><p id="here">${name}</p>`)
})

type Answer = Awaited<ReturnType<typeof run>>
const tabOf = (tab?: string) => sessions.activeSession(ownerOf(lead), tab) as ReturnType<typeof sessions.activeSession>
const within = async (work: Promise<Answer>, ms: number): Promise<Answer> =>
  Promise.race([work, new Promise<Answer>(done => setTimeout(() => done({ result: `still pending after ${ms}ms`, outcome: 'pending', ms }), ms))])
const crash = async (tab?: string): Promise<boolean> => {
  const live = tabOf(tab)
  const own = live === null ? null : sessions.pageKitOf(live.page)?.cdp
  if (!own) return false
  void own.send('Page.crash').catch(() => undefined)
  for (let waited = 0; waited < 50; waited++) {
    if ((tabOf(tab) as { crashed?: boolean } | null)?.crashed === true) return true
    await new Promise(done => setTimeout(done, 100))
  }
  return false
}
const fieldOf = (tab?: string): Promise<string> =>
  (tabOf(tab) === null ? Promise.reject(new Error('no tab')) : pageOf(lead, tab).$eval('#field', el => (el as HTMLInputElement).value)).catch((err: Error) => `unreadable: ${err.message}`)

section('S0 control: three tabs, alive (holds on the parent too)')
{
  await run({ op: 'open', url: `${A.origin}/main` })
  await run({ op: 'open', tab: 'work', url: `${A.origin}/one` })
  await run({ op: 'open', tab: 'beside', url: `${A.origin}/beside` })
  await run({ op: 'type', selector: '#field', text: 'main keeps this' })
  await run({ op: 'click', tab: 'work', selector: '#next' })
  const typed = await run({ op: 'type', tab: 'work', selector: '#field', text: 'lost with the crash' })
  check('three tabs take acts', typed.outcome === 'succeeded' && (await fieldOf('work')) === 'lost with the crash' && (await fieldOf()) === 'main keeps this', typed.result)
}

section('S1 a crashed tab is named at once')
{
  const noticed = await crash('work')
  check('the crash is noticed without a call', noticed)
  const words = 'tab work crashed (its process exited) — op:"reload" loads it again with its form values and script state gone; op:"close" with tab:"work" drops it'
  const clicked = await within(run({ op: 'click', tab: 'work', selector: '#next' }), 5000)
  const read = await within(run({ op: 'extract', tab: 'work' }), 5000)
  const info = await within(run({ op: 'info', tab: 'work' }), 5000)
  const shot = await within(run({ op: 'screenshot', tab: 'work', label: 'crashed' }), 5000)
  check('[M08] an act on it answers at once with what happened and the two ways on', clicked.outcome === 'failed' && clicked.result === words && clicked.ms < 2000, `${clicked.result} ${clicked.ms}ms`)
  check('[M08] and so do a read, info and a screenshot', read.result === words && info.result === words && shot.result === words, `${read.result} | ${info.result} | ${shot.result}`)
  const ring = await within(run({ op: 'console', tab: 'work' }), 5000)
  check('its console ring is still read, and holds the crash', ring.outcome !== 'failed' && ring.result.includes('crash: the page crashed (its process exited); op:"reload" loads it again'), ring.result.split('\n').slice(-2).join(' | '))
  const status = await within(run({ op: 'status' }), 5000)
  check('[M03] status shows the tab as crashed', status.result.includes(`  work: ${A.origin}/two (page 2; viewport 1280x800; idle lease; crashed)`), status.result.split('\n').filter(line => line.startsWith('  work')).join(''))
  const beside = await within(run({ op: 'type', tab: 'beside', selector: '#field', text: 'untouched' }), 5000)
  check('[B03] the tabs beside it are untouched: their pages, values and acts', beside.outcome === 'succeeded' && (await fieldOf('beside')) === 'untouched' && (await fieldOf()) === 'main keeps this', beside.result)
}

section('S2 the recovery says what it kept and what it lost')
{
  const reloaded = await within(run({ op: 'reload', tab: 'work' }), 20000)
  check('[M08][B03] reload loads the page again and says it is a fresh load', reloaded.outcome === 'succeeded' && reloaded.result === `[work] reload: ${A.origin}/two [200] — two\n  note: the page had crashed and this is a fresh load: form values and script state are gone; history, cookies and stored data stay`, reloaded.result)
  check('[B03] the form value is gone, as it said', (await fieldOf('work')) === '')
  const back = await within(run({ op: 'back', tab: 'work' }), 20000)
  check('[B03] and the history stays, as it said', back.result.startsWith(`[work] back: ${A.origin}/one`), back.result)
  const again = await within(run({ op: 'reload', tab: 'work' }), 20000)
  check('a reload after the recovery is an ordinary reload', again.outcome === 'succeeded' && again.result === `[work] reload: ${A.origin}/one [200] — one`, again.result)
  await run({ op: 'open', tab: 'work', url: `${A.origin}/detect` })
  await crash('work')
  const fresh = await within(run({ op: 'reload', tab: 'work' }), 20000)
  const nine = fresh.outcome === 'succeeded' ? await detect(lead, 'work') : { passed: 0, total: 9, checks: {} }
  check('[G5] the nine baseline assertions hold on the page after a recovery', fresh.result.includes('this is a fresh load') && nine.passed === 9 && nine.total === 9, `${fresh.result} ${JSON.stringify(nine.checks)}`)
}

section('S3 a crash in the middle of a wait')
{
  await run({ op: 'open', tab: 'work', url: `${A.origin}/one` })
  const waiting = run({ op: 'waitFor', tab: 'work', selector: '#never', timeoutMs: 30000 })
  await new Promise(done => setTimeout(done, 400))
  const t0 = Date.now()
  await crash('work')
  const settled = await within(waiting, 6000)
  check('[M08] the wait ends at once and names the crash, not a deadline', settled.outcome === 'failed' && settled.result === 'waitFor: tab work crashed (its process exited mid-op) — op:"reload" loads it again with its form values and script state gone; op:"close" with tab:"work" drops it' && Date.now() - t0 < 6000, `${settled.result} ${Date.now() - t0}ms`)
  const opened = await within(run({ op: 'open', tab: 'work', url: `${A.origin}/two` }), 20000)
  check('[B03] an open on the crashed tab recovers it too, and says so', opened.outcome === 'succeeded' && opened.result.includes(`[work] open: ${A.origin}/two [200] — two`) && opened.result.includes('\n  note: the page had crashed and this is a fresh load'), opened.result)
}

section('S4 the unnamed page')
{
  await crash()
  const acted = await within(run({ op: 'click', selector: '#next' }), 5000)
  check('[M08] a call that names no tab says the page crashed and how close ends', acted.result === 'the page crashed (its process exited) — op:"reload" loads it again with its form values and script state gone; op:"close" ends the session', acted.result)
  const reloaded = await within(run({ op: 'reload' }), 20000)
  check('and its reload recovers it', reloaded.outcome === 'succeeded' && reloaded.result.startsWith(`reload: ${A.origin}/main [200] — main\n  note: the page had crashed`) && (await fieldOf()) === '', reloaded.result)
}

section('S5 order, cancellation, a cancelled creation, and a secret’s approval')
{
  const asked = await permission({ op: 'type', tab: 'beside', selector: '#field', secretRef: 'TABS_SECRET' })
  sessions.approveSecretPairing(ownerOf(lead), 'TABS_SECRET', A.origin)
  const onBeside = await permission({ op: 'type', tab: 'beside', selector: '#field', secretRef: 'TABS_SECRET' })
  const onWork = await permission({ op: 'type', tab: 'work', selector: '#field', secretRef: 'TABS_SECRET' })
  check('[M12] a secret asks for its pairing with the origin, naming the tab, and that approval holds on every tab of the origin', asked.behavior === 'ask' && asked.message === `Browser fill secret TABS_SECRET into ${A.origin} in tab beside (target #field) — the value never enters the conversation; approve exactly this secret-origin pairing` && onBeside.behavior === 'allow' && onWork.behavior === 'allow', JSON.stringify([asked, onBeside, onWork]))
  check('[M06] calls on a tab are ordered by the road that orders every call of this tool, and an interrupt cancels', BrowserTool.isConcurrencySafe({ op: 'click', tab: 'work', selector: '#next' } as never) === false && BrowserTool.isConcurrencySafe({ op: 'status' } as never) === true && BrowserTool.interruptBehavior?.() === 'cancel')
  const stop = new AbortController()
  const creating = run({ op: 'open', tab: 'cancelled', url: `${A.origin}/slow` }, { abortController: stop } as never)
  stop.abort()
  const answer = await within(creating, 20000)
  await new Promise(done => setTimeout(done, 1500))
  const tabs = ((sessions.browserTabs?.(ownerOf(lead)) ?? []) as Array<{ tab: string; browser: { pages(): Promise<unknown[]> } }>)
  const browsers = [...new Set(tabs.map(live => live.browser))]
  let pages = 0
  for (const browser of browsers) pages += (await browser.pages()).length
  check('[M07] an interrupted creation answers as interrupted and leaves no page without a tab', answer.outcome === 'failed' && answer.result.includes('open interrupted by the operator') && pages === tabs.length, `${answer.result} pages=${pages} tabs=${tabs.map(live => live.tab).join(',')}`)
}

await finish('prove-browser-crash')
