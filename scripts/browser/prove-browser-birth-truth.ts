#!/usr/bin/env bun
import { check, finish, lead, ownerOf, pageOf, requireBrowser, run, serve, sessions } from './harness.ts'

await requireBrowser()

const seen: string[] = []
const A = await serve(0, (req, res) => {
  if (req.url === '/child') seen.push(String(req.headers['user-agent']))
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(req.url === '/opener' ? '<title>opener</title><a id="link" target="_blank" href="/child">open</a>' : '<title>child</title><input id="field">')
})
await run({ op: 'open', url: `${A.origin}/opener` })
const main = sessions.pageKitOf(pageOf())!.cdp!
const proto = Object.getPrototypeOf(main) as { send: (...args: unknown[]) => Promise<unknown> }
const send = proto.send
const delayed: Array<() => void> = []
const writes: Promise<unknown>[] = []
proto.send = function (this: unknown, method: unknown, ...args: unknown[]) {
  if (this !== main && method === 'Emulation.setUserAgentOverride') {
    const write = new Promise<unknown>((resolve, reject) => {
      delayed.push(() => { void send.call(this, method, ...args).then(resolve, reject) })
    })
    writes.push(write)
    return write
  }
  return send.call(this, method, ...args)
}
try {
  const answer = await run({ op: 'click', selector: '#link' })
  const note = 'note: tab popup: its first request was not armed with the presented browser identity; the page stayed open'
  check('the seam delays only the identity write, not the request or either resume', delayed.length === 1 && seen.length === 1 && seen[0]!.includes('HeadlessChrome'), JSON.stringify(seen))
  check('the act names the observed unarmed first request without refusing or closing the tab', answer.outcome === 'succeeded' && answer.result.includes(note) && sessions.activeSession(ownerOf(lead), 'popup') !== null, answer.result)
  for (const release of delayed.splice(0)) release()
  await Promise.all(writes)
  const info = await run({ op: 'info', tab: 'popup' })
  check('info keeps that first-request fact after the identity write finishes', info.result.includes(note), info.result)
  const typed = await run({ op: 'type', tab: 'popup', selector: '#field', text: 'still usable' })
  check('the tab remains usable without a replay or an extra request', typed.outcome === 'succeeded' && seen.length === 1, typed.result)
  const named = await run({ op: 'open', tab: 'delayed', url: `${A.origin}/child` })
  const namedInfo = await run({ op: 'info', tab: 'delayed' })
  check('a named tab reports the same observed race on open and info', seen[1]?.includes('HeadlessChrome') === true && named.result.includes('note: tab delayed: its first request was not armed') && namedInfo.result.includes('note: tab delayed: its first request was not armed'), `${named.result} | ${namedInfo.result}`)
} finally {
  proto.send = send
  for (const release of delayed.splice(0)) release()
  await Promise.allSettled(writes)
}
const armed = await run({ op: 'click', selector: '#link' })
const info = await run({ op: 'info', tab: 'popup-2' })
check('an armed first request never gains the warning', armed.outcome === 'succeeded' && seen.length === 3 && !seen[2]!.includes('HeadlessChrome') && !armed.result.includes('not armed') && !info.result.includes('not armed'), `${armed.result} | ${info.result}`)
await run({ op: 'open', tab: 'named', url: `${A.origin}/child` })
check('a normally armed named page has no warning either', !(await run({ op: 'info', tab: 'named' })).result.includes('not armed'))
await finish('prove-browser-birth-truth')
