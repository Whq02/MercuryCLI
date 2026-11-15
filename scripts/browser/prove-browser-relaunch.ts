#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import type http from 'node:http'
import { join } from 'node:path'
import { check, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const armed = (req: http.IncomingMessage): boolean => String(req.headers['sec-ch-ua'] ?? '').includes('Google Chrome')
const A = await serve(27290, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>${(req.url ?? '/').slice(1) || 'root'}</title><p id="here">${req.url}</p>`)
})
const profile = sessions.browserProfileDirForOrigin(A.origin, ownerOf(lead)) as string
const pagesNow = async (): Promise<string[]> => (await sessions.activeSession(ownerOf(lead))!.browser.pages()).map((page: { url(): string }) => page.url())
const since = (mark: number): string[] => A.hits.slice(mark).map(hit => `${hit.url}${armed(hit) ? '' : ' with the raw brand list'}`)

section('S0 control: the first launch on an origin’s profile (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/one` })
  check('the browser holds the one page that was opened', opened.outcome === 'succeeded' && (await pagesNow()).join(',') === `${A.origin}/one`, (await pagesNow()).join(' , '))
  await pageOf().evaluate(() => {
    document.cookie = 'kept=cookie-27290; max-age=3600; path=/'
    localStorage.setItem('kept', 'storage-27290')
  })
  const closed = await run({ op: 'close' })
  const silent = closed.result === `session closed — the browser did not answer within ${sessions.BROWSER_CLOSE_BOUND_MS / 1000}s and its process was ended (origin approvals wiped)`
  const unfinished = closed.result === `session closed — the browser did not finish quitting within ${sessions.BROWSER_FINISH_BOUND_MS / 1000}s and its process was ended (origin approvals wiped)`
  check('close ends the session and leaves the profile on disk', (silent || unfinished || closed.result === 'session closed (browser reaped; origin approvals wiped)') && existsSync(join(profile, 'Default')), closed.result)
  if (silent) console.log(`    this machine’s browser had not taken the quit ${sessions.BROWSER_CLOSE_BOUND_MS / 1000}s after it was asked, and its process was ended: the sections below read what that profile kept`)
  if (unfinished) console.log(`    this machine’s browser took the quit and had not exited ${sessions.BROWSER_FINISH_BOUND_MS / 1000}s after it, and its process was ended: the sections below read what that profile kept`)
  if (!silent && !unfinished && closed.ms >= sessions.BROWSER_CLOSE_BOUND_MS) console.log(`    this machine’s browser took the quit and needed ${closed.ms} ms to exit: the close waited for it`)
}

section('S1 the browser started again on that profile')
{
  const mark = A.hits.length
  const opened = await run({ op: 'open', url: `${A.origin}/two` })
  await new Promise(done => setTimeout(done, 600))
  const pages = await pagesNow()
  check('holds one page, the one that was opened: no page of the earlier session comes back', opened.outcome === 'succeeded' && pages.length === 1 && pages[0] === `${A.origin}/two`, pages.join(' , '))
  const asked = since(mark)
  check('the site receives no request before the open’s own, and none with the raw brand list', asked[0] === '/two' && asked.every(line => !line.includes('raw brand list')), asked.join(' | '))
  const back = await run({ op: 'back' })
  check('back does not lead into the earlier session: behind the page is only the blank page the browser started on', back.result.startsWith('back: about:blank') && pageOf().url() === 'about:blank', back.result)
  await run({ op: 'open', url: `${A.origin}/two` })
  const kept = await pageOf().evaluate(() => [document.cookie, localStorage.getItem('kept')])
  check('the cookie and the stored value of the earlier session are there', String(kept[0]).includes('kept=cookie-27290') && kept[1] === 'storage-27290', JSON.stringify(kept))
  await run({ op: 'close' })
}

section('S2 and again')
{
  const mark = A.hits.length
  await run({ op: 'open', url: `${A.origin}/three` })
  await new Promise(done => setTimeout(done, 600))
  const pages = await pagesNow()
  const asked = since(mark)
  check('a third start holds one page and asks the site nothing of its own', pages.length === 1 && pages[0] === `${A.origin}/three` && asked[0] === '/three' && asked.every(line => !line.includes('raw brand list')), `${pages.join(' , ')} · ${asked.join(' | ')}`)
  const kept = await pageOf().evaluate(() => [document.cookie, localStorage.getItem('kept')])
  check('and the profile still keeps what the site stored', String(kept[0]).includes('kept=cookie-27290') && kept[1] === 'storage-27290', JSON.stringify(kept))
}

await finish('prove-browser-relaunch')
