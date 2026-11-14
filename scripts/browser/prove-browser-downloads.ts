#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { BrowserTool, ROOT, check, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions, validate } from './harness.ts'

await requireBrowser()

const bytesOf = (seed: string, size: number): Buffer => Buffer.alloc(size, seed)
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const asked = new Map<string, number>()
let cut: http.ServerResponse | null = null
const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  asked.set(url.pathname, (asked.get(url.pathname) ?? 0) + 1)
  if (url.pathname === '/file') {
    const body = bytesOf(url.searchParams.get('seed') ?? 'a', 1000)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${url.searchParams.get('name') ?? 'payload.bin'}"`, 'content-length': String(body.length) })
    res.end(body)
    return
  }
  if (url.pathname === '/untyped') {
    res.writeHead(200, { 'content-disposition': 'attachment; filename="untyped"', 'content-length': '5' })
    res.end('12345')
    return
  }
  if (url.pathname === '/slow') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="slow.bin"', 'content-length': '60000' })
    let sent = 0
    const tick = setInterval(() => {
      res.write(bytesOf('s', 10000))
      sent += 10000
      if (sent >= 60000) {
        clearInterval(tick)
        res.end()
      }
    }, 500)
    res.on('close', () => clearInterval(tick))
    return
  }
  if (url.pathname === '/cut') {
    if ((asked.get('/cut') ?? 0) > 1) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="cut.bin"', 'content-length': '50000' })
    res.write(bytesOf('c', 10000))
    cut = res
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (url.pathname === '/framed') {
    res.end('<title>framed</title><a id="inner" href="/file?seed=f&name=framed.bin">inner</a>')
    return
  }
  if (url.pathname === '/pushes') {
    res.end(`<!doctype html><title>pushes</title><p>your download starts by itself</p><script>setTimeout(() => { location.href = '/file?seed=p&name=pushed.bin' }, 1500)</script>`)
    return
  }
  res.end(`<!doctype html><title>exports</title>
<button id="plain" onclick="document.title='clicked'">plain</button>
<a id="dl" href="/file">dl</a>
<a id="named" href="/file?seed=b&name=report.csv">named</a>
<a id="newtab" target="_blank" href="/file?seed=n&name=newtab.bin">newtab</a>
<a id="slow" href="/slow">slow</a>
<a id="cut" href="/cut">cut</a>
<a id="untyped" href="/untyped">untyped</a>
<a id="escape" href="/file?seed=e&name=..%2F..%2Fescape.txt">escape</a>
<button id="later" onclick="setTimeout(() => { location.href = '/file?seed=l&name=later.bin' }, 1500)">later</button>
<button id="blob" onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['made,by,the,page\\n'], { type: 'text/csv' })); a.download = 'made.csv'; a.click()">blob</button>
<iframe id="frame" src="/framed"></iframe>`)
}
const A = await serve(27295, handler)
const B = await serve(27296, handler)

type Ctx = typeof lead
const second: Ctx = { agentId: 'downloads-second-owner' }
const third: Ctx = { agentId: 'downloads-third-owner' }
interface Held {
  id: string
  state: string
  path: string | null
  bytes: number | null
  sha256: string | null
  tab: string
}
const transfers = (ctx: Ctx = lead): Held[] => (sessions.browserTransfers?.(ownerOf(ctx)) ?? []) as Held[]
const savedOf = (answer: { result: string }): { path: string; id: string } | null => {
  const hit = /saved to (.+?) \(.*\) — download (d\d+), in the session scratchpad/.exec(answer.result)
  return hit ? { path: hit[1]!, id: hit[2]! } : null
}
const fileIs = (path: string | null | undefined, bytes: Buffer): boolean => typeof path === 'string' && existsSync(path) && readFileSync(path).equals(bytes)
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const pads = (): string[] => {
  const root = realpathSync(tmpdir())
  const found: string[] = []
  for (const top of readdirSync(root)) {
    if (!/^mercury(-\d+)?$/.test(top)) continue
    for (const project of readdirSync(join(root, top))) {
      const at = join(root, top, project)
      if (!statSync(at).isDirectory()) continue
      for (const session of readdirSync(at)) found.push(join(at, session, 'scratchpad'))
    }
  }
  return found
}
const homes = (): string[] => pads().map(pad => join(pad, 'browser-downloads')).filter(folder => existsSync(folder))
let home = ''
const tabNames = (): string => ((sessions.browserTabs?.(ownerOf(lead)) ?? []) as Array<{ tab: string }>).map(t => t.tab).join(',')
const NOT_SAVED = 'not saved: no act of this agent started it; op:"download" with url (the page’s address) or selector (what starts it) saves it'

section('S0 control: an act that starts no download (holds on the parent too)')
{
  const opened = await run({ op: 'open', url: `${A.origin}/` })
  const plain = await run({ op: 'click', selector: '#plain' })
  check('a click that starts nothing answers as today', opened.outcome === 'succeeded' && plain.result === `click #plain at ${A.origin}/`, plain.result)
  check('[G3] nothing is written for downloads before one begins', homes().length === 0, homes().join(' '))
}

section('S1 a download that an act starts is saved and named in that act’s answer')
{
  const clicked = await run({ op: 'click', selector: '#dl' })
  const saved = savedOf(clicked)
  const body = bytesOf('a', 1000)
  check('[D2][M08] the click’s answer says where it was saved, its size, declared type, suggested name, source and digest', clicked.outcome === 'succeeded' && saved !== null && clicked.result === `click #dl at ${A.origin}/\n  note: the link is a download — saved to ${saved.path} (1000 bytes, application/zip, suggested name payload.bin, from ${A.origin}/file, sha256 ${sha(body)}) — download ${saved.id}, in the session scratchpad`, clicked.result)
  check('[B01] the file is there, whole, and the digest is the file’s own', fileIs(saved?.path, body) && saved?.id === 'd1')
  home = homes()[0] ?? ''
  check('[D2][B02] it lies in a place of its own under the session scratchpad', saved !== null && saved.path === join(home, 'd1', 'payload.bin') && home.endsWith(`${sep}scratchpad${sep}browser-downloads`), saved?.path ?? '')
  check('the page stayed where it was', pageOf().url() === `${A.origin}/` && (await pageOf().title()) === 'clicked')
  const opened = await run({ op: 'open', tab: 'direct', url: `${A.origin}/file?seed=o&name=opened.bin` })
  const direct = savedOf(opened)
  check('[D2] an open whose address is a download saves it and says the tab did not move', opened.outcome === 'succeeded' && direct !== null && opened.result.startsWith(`[direct] open: ${A.origin}/file?seed=o&name=opened.bin is a download — saved to ${direct.path} (1000 bytes, application/zip, suggested name opened.bin, from ${A.origin}/file?…, sha256 ${sha(bytesOf('o', 1000))})`) && opened.result.endsWith('\n  note: the tab stays at about:blank') && fileIs(direct.path, bytesOf('o', 1000)), opened.result)
  await pageOf().focus('#named')
  const pressed = await run({ op: 'press', key: 'Enter' })
  const viaKey = savedOf(pressed)
  check('[D2] a key that starts a download saves it too', viaKey !== null && pressed.result.includes('suggested name report.csv') && fileIs(viaKey.path, bytesOf('b', 1000)), pressed.result)
  await run({ op: 'close', tab: 'direct' })
}

section('S2 the right tab, the right frame, and names that cannot collide or escape')
{
  const framed = await run({ op: 'click', frame: 1, selector: '#inner' })
  const inFrame = savedOf(framed)
  check('[M09] a download started in a child frame is saved and belongs to its tab', inFrame !== null && fileIs(inFrame.path, bytesOf('f', 1000)) && transfers().find(t => t.id === inFrame.id)?.tab === 'main' && framed.result.includes('application/zip'), framed.result)
  await run({ op: 'open', tab: 'other', url: `${B.origin}/` })
  const again = await run({ op: 'click', selector: '#dl' })
  const elsewhere = await run({ op: 'click', tab: 'other', selector: '#dl' })
  const mine = savedOf(again)
  const theirs = savedOf(elsewhere)
  check('[M09][B02] two tabs exporting the same suggested name keep two files', mine !== null && theirs !== null && mine.path !== theirs.path && fileIs(mine.path, bytesOf('a', 1000)) && fileIs(theirs.path, bytesOf('a', 1000)) && transfers().find(t => t.id === theirs.id)?.tab === 'other' && elsewhere.result.startsWith(`[other] click #dl at ${B.origin}/`), `${again.result} | ${elsewhere.result}`)
  const escaped = await run({ op: 'click', selector: '#escape' })
  const held = savedOf(escaped)
  check('[B02] a suggested name with a path in it stays inside its own folder', held !== null && dirname(held.path).endsWith(`${sep}browser-downloads${sep}${held.id}`) && basename(held.path) === '_.._escape.txt' && fileIs(held.path, bytesOf('e', 1000)), escaped.result)
  const untyped = await run({ op: 'click', selector: '#untyped' })
  check('[D2] a download with no declared type says so', untyped.result.includes('(5 bytes, type unknown, suggested name untyped,'), untyped.result)
  const newTab = await run({ op: 'click', selector: '#newtab' })
  const fromTab = savedOf(newTab)
  check('[D2] a download that starts in a new tab is saved for the act that opened it, and no tab is kept for it', fromTab !== null && fileIs(fromTab.path, bytesOf('n', 1000)) && newTab.result.includes('note: the link is a download — saved to') && tabNames() === 'main,other', newTab.result)
  const taken = transfers().length + 1
  mkdirSync(join(home, `d${taken}`), { recursive: true })
  const beside = await run({ op: 'click', selector: '#dl' })
  check('[B02] a transfer never takes a folder that is already there', savedOf(beside)?.id === `d${taken + 1}` && readdirSync(join(home, `d${taken}`)).length === 0, `d${taken} | ${beside.result}`)
  const made = await run({ op: 'click', selector: '#blob' })
  await nap(700)
  const madeNext = await run({ op: 'info' })
  const blob = savedOf(made) ?? savedOf(madeNext)
  check('a file the page itself generates is saved with its bytes, and named in the click’s answer or the next one', blob !== null && fileIs(blob.path, Buffer.from('made,by,the,page\n')) && `${made.result}${madeNext.result}`.includes(`suggested name made.csv, from blob:${A.origin}/`), `${made.result} | ${madeNext.result}`)
  const soughtBlob = await run({ op: 'download', selector: '#blob' })
  check('[M08] download with its selector names a generated file in the same answer', savedOf(soughtBlob) !== null && soughtBlob.result.startsWith(`click #blob at ${A.origin}/\n  note: `) && soughtBlob.result.includes('suggested name made.csv'), soughtBlob.result)
}

section('S3 a slow export is followed, not replayed')
{
  const before = asked.get('/slow') ?? 0
  const clicked = await run({ op: 'click', selector: '#slow' })
  const id = /download (d\d+) is still arriving/.exec(clicked.result)?.[1] ?? ''
  check('[B03][D2] the act answers pending with an id, never complete', id !== '' && clicked.result.includes(` of 59 KB of slow.bin from ${A.origin}/slow) — op:"download" with downloadId:"${id}" waits for it`) && !clicked.result.includes('saved to'), clicked.result)
  const short = await run({ op: 'download', downloadId: id, timeoutMs: 250 })
  check('[D3][M12] a wait that ends before the file does answers pending', short.outcome === 'no-change' && short.result.startsWith(`download: download ${id} is still arriving (`), short.result)
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 200)
  const stopped = await run({ op: 'download', downloadId: id, timeoutMs: 30000 }, { ...lead, abortController: stop })
  check('[M13] a wait is interruptible, and ending the wait does not end the transfer', stopped.result === 'download interrupted by the operator — the wait was released, nothing further was done' && stopped.ms < 3000 && transfers().find(t => t.id === id)?.state === 'pending', `${stopped.result} ${stopped.ms}ms`)
  const whole = await run({ op: 'download', downloadId: id, timeoutMs: 30000 })
  const saved = savedOf(whole)
  check('[D3][B03][M13] continued, the same transfer completes with its verified bytes', whole.outcome === 'succeeded' && saved !== null && saved.id === id && fileIs(saved.path, bytesOf('s', 60000)) && whole.result.includes(`sha256 ${sha(bytesOf('s', 60000))}`), whole.result)
  check('[B03] the server was asked once: no second click, no second request', (asked.get('/slow') ?? 0) === before + 1, `${(asked.get('/slow') ?? 0) - before}`)
  const done = await run({ op: 'download', downloadId: id })
  check('[D3] asked again, a finished transfer answers at once with the same receipt', done.result === whole.result && done.ms < 2000, `${done.result} ${done.ms}ms`)
}

section('S4 the list, and what the lane does not save')
{
  const listed = await run({ op: 'download' })
  const lines = listed.result.split('\n')
  check('[D3][M10] download without an id lists the session’s transfers with their state and place', lines[0] === `downloads: ${transfers().length} (${transfers().length} complete, 0 arriving, 0 failed)` && lines[1]!.startsWith('  tab main: saved to ') && lines.length === transfers().length + 1 && listed.outcome === 'no-change', listed.result)
  const paged = await run({ op: 'download', limit: 2 })
  const rest = await run({ op: 'download', offset: 2, limit: 2 })
  check('[M10] a long list continues, it is not cut short', paged.result.split('\n').length === 4 && paged.result.includes(`  … ${transfers().length - 2} more — continue with offset: 2`) && rest.result.split('\n')[0] === `downloads: ${transfers().length} (${transfers().length} complete, 0 arriving, 0 failed), from 2`, `${paged.result} || ${rest.result}`)
  check('[B01] nothing an answer named is missing or a different size', transfers().every(t => t.state === 'complete' && t.path !== null && existsSync(t.path) && statSync(t.path).size === t.bytes))
}

section('S4b a download that begins after the act that caused it has returned')
{
  const count = transfers().length
  const later = await run({ op: 'click', selector: '#later' })
  await nap(2300)
  const next = await run({ op: 'info' })
  const saved = savedOf(next)
  check('[D2] an export that begins 1.5 s after the click is saved', later.result === `click #later at ${A.origin}/` && transfers().length === count + 1 && saved !== null && fileIs(saved.path, bytesOf('l', 1000)), `${later.result} | ${next.result}`)
  check('[D2] and the next answer on that tab names it', next.result.includes(`\n  note: a download began after the last act — saved to ${saved?.path} (1000 bytes, application/zip, suggested name later.bin, from ${A.origin}/file?…, sha256 ${sha(bytesOf('l', 1000))}) — download ${saved?.id}, in the session scratchpad`), next.result)
  const again = await run({ op: 'info' })
  check('once', !again.result.includes('a download began'), again.result)
  const quiet = await run({ op: 'open', tab: 'quiet', url: `${A.origin}/pushes` })
  await nap(2300)
  const read = await run({ op: 'info', tab: 'quiet' })
  const ring = await run({ op: 'console', tab: 'quiet' })
  await nap(300)
  const incoming = existsSync(join(home, 'incoming')) ? readdirSync(join(home, 'incoming')) : []
  check('[D2] on a tab that was only opened, a file the page pushes by itself is not saved', quiet.outcome === 'succeeded' && transfers().length === count + 1 && incoming.length === 0, `${transfers().length - count} | ${incoming.join(',')}`)
  check('and the line that says so names the road', read.result.includes(`\n  note: the page asked to download pushed.bin (${A.origin}/file?…) — ${NOT_SAVED}`) && ring.result.includes(`download: the page asked to download pushed.bin (${A.origin}/file?…) — ${NOT_SAVED}`), `${read.result} | ${ring.result.split('\n').slice(-2).join(' | ')}`)
  const brief = await run({ op: 'download', tab: 'quiet', url: `${A.origin}/pushes`, timeoutMs: 400 })
  check('[D2] download with the page’s address opens it and, when the wait ends first, says the tab stays followed', brief.outcome === 'succeeded' && brief.result.startsWith(`[quiet] open: ${A.origin}/pushes [200] — pushes`) && brief.result.endsWith('\n  note: no download has begun in 400 ms — this tab stays followed: one that begins later is saved and named in the next answer on it') && transfers().length === count + 1, brief.result)
  await nap(2000)
  const after = await run({ op: 'info', tab: 'quiet' })
  const pushed = savedOf(after)
  check('[D2] a tab the agent only used download on is followed after the wait returned', pushed !== null && fileIs(pushed.path, bytesOf('p', 1000)) && after.result.includes('\n  note: a download began after the last act — saved to ') && transfers().find(t => t.id === pushed.id)?.tab === 'quiet', after.result)
  const waited = await run({ op: 'download', tab: 'quiet', url: `${A.origin}/pushes`, timeoutMs: 9000 })
  const inWait = savedOf(waited)
  check('[M08] download with an address waits for the file the page starts and names it in the same answer', inWait !== null && fileIs(inWait.path, bytesOf('p', 1000)) && waited.result.includes('\n  note: the page started a download — saved to ') && waited.ms < 8000, `${waited.result} ${waited.ms}ms`)
  const bySelector = await run({ op: 'download', selector: '#later', timeoutMs: 9000 })
  const sought = savedOf(bySelector)
  check('[M08] download with a selector clicks it and waits for the file', sought !== null && fileIs(sought.path, bytesOf('l', 1000)) && bySelector.result.startsWith(`click #later at ${A.origin}/\n  note: the page started a download — saved to `) && bySelector.ms < 8000, `${bySelector.result} ${bySelector.ms}ms`)
  const direct = await run({ op: 'download', selector: '#dl' })
  check('a download the click itself starts is named once, in the click’s own words', savedOf(direct) !== null && direct.result.split('\n').length === 2 && direct.result.startsWith(`click #dl at ${A.origin}/\n  note: the link is a download — saved to `), direct.result)
  const fresh = await run({ op: 'open', url: `${A.origin}/pushes` })
  await nap(2300)
  const unsaved = await run({ op: 'info' })
  check('a plain open starts the tab afresh: what the new page pushes by itself is not saved', fresh.outcome === 'succeeded' && unsaved.result.includes(`— ${NOT_SAVED}`) && !unsaved.result.includes('a download began'), unsaved.result)
  await run({ op: 'close', tab: 'quiet' })
  await run({ op: 'open', url: `${A.origin}/` })
  check('nothing an answer named is missing', transfers().every(t => t.state === 'complete' && t.path !== null && existsSync(t.path) && statSync(t.path).size === t.bytes))
}

section('S4c a browser stays for a download that is still arriving in it')
{
  const moving = await run({ op: 'click', tab: 'other', selector: '#slow' })
  const id = /download (d\d+) is still arriving/.exec(moving.result)?.[1] ?? ''
  const old = (sessions.activeSession(ownerOf(lead), 'other') as { browser: { connected: boolean } } | null)?.browser
  const moved = await run({ op: 'open', tab: 'other', url: `${A.origin}/framed` })
  const whole = await run({ op: 'download', downloadId: id, timeoutMs: 30000 })
  check('[B03] a tab that moves to another origin leaves its old browser running for the download still arriving there', id !== '' && moved.outcome === 'succeeded' && whole.outcome === 'succeeded' && fileIs(savedOf(whole)?.path, bytesOf('s', 60000)), `${moving.result} | ${moved.result} | ${whole.result}`)
  await nap(1500)
  check('and that browser closes when the transfer has ended', old !== undefined && old.connected === false && tabNames() === 'main,other', tabNames())
  await run({ op: 'open', tab: 'other', url: `${B.origin}/` })
  const relaunched = await run({ op: 'click', tab: 'other', selector: '#slow' })
  const relaunchedId = /download (d\d+) is still arriving/.exec(relaunched.result)?.[1] ?? ''
  const again = await run({ op: 'download', downloadId: relaunchedId, timeoutMs: 30000 })
  check('a browser started again on a profile that downloaded before completes a download in progress', relaunchedId !== '' && again.outcome === 'succeeded' && fileIs(savedOf(again)?.path, bytesOf('s', 60000)), `${relaunched.result} | ${again.result}`)
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
  const expire = (): void => {
    const last = [...leases.entries()].at(-1)
    if (last === undefined) return
    leases.delete(last[0])
    last[1]()
  }
  try {
    await run({ op: 'open', url: `${A.origin}/` }, third)
    const leased = await run({ op: 'click', selector: '#slow' }, third)
    const leasedId = /download (d\d+) is still arriving/.exec(leased.result)?.[1] ?? ''
    expire()
    await nap(200)
    check('[B03] the idle lease does not close a browser while its download keeps arriving', leasedId !== '' && sessions.activeSession(ownerOf(third)) !== null && transfers(third).find(t => t.id === leasedId)?.state === 'pending', leased.result)
    const done = await run({ op: 'download', downloadId: leasedId, timeoutMs: 30000 }, third)
    expire()
    await nap(500)
    check('and closes it as before once nothing is arriving', done.outcome === 'succeeded' && sessions.activeSession(ownerOf(third)) === null && fileIs(savedOf(done)?.path, bytesOf('s', 60000)), done.result)
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }
}

section('S5 a transfer that does not finish says how it ended')
{
  const clicked = await run({ op: 'click', selector: '#cut' })
  const id = /download (d\d+) is still arriving/.exec(clicked.result)?.[1] ?? ''
  ;(cut as http.ServerResponse | null)?.destroy()
  const stalled = await run({ op: 'download', downloadId: id, timeoutMs: 7000 })
  check('[M12] a transfer the server cut off is never called complete: the wait answers pending and says no bytes are coming', id !== '' && stalled.outcome === 'no-change' && /^download: download d\d+ is still arriving \(9\.8 KB of 49 KB of cut\.bin from http:\/\/127\.0\.0\.1:27295\/cut; no new bytes for \d+ s\) — op:"download" with downloadId:"d\d+" waits for it$/.test(stalled.result) && transfers().find(t => t.id === id)?.path === null, `${clicked.result} | ${stalled.result}`)
  const slow = await run({ op: 'click', tab: 'other', selector: '#slow' })
  const pending = /download (d\d+) is still arriving/.exec(slow.result)?.[1] ?? ''
  await run({ op: 'close' })
  const after = await run({ op: 'download', downloadId: pending })
  check('[M12] a transfer whose browser closed is a failure that says so', pending !== '' && after.outcome === 'failed' && after.result === `download: download ${pending} failed: its browser closed before the file was whole (slow.bin from ${B.origin}/slow)`, `${slow.result} | ${after.result}`)
  const kept = await run({ op: 'download' })
  check('[D3] the finished files and the list outlive the browser, and both unfinished transfers ended with it', kept.result.includes('complete, 0 arriving, 2 failed)') && kept.result.includes(`download ${id} failed: its browser closed before the file was whole (cut.bin from ${A.origin}/cut)`) && transfers().filter(t => t.state === 'complete').every(t => t.path !== null && existsSync(t.path)), kept.result.split('\n')[0] ?? '')
  const unknown = await run({ op: 'download', downloadId: 'd999' })
  check('[M14] an id that is not this session’s says so', unknown.outcome === 'failed' && unknown.result === `no download d999 — op:"download" without downloadId lists the ${transfers().length} of this session`, unknown.result)
  check('[G3] the browser’s own folder is gone with the last browser, the saved files stay', !existsSync(join(home, 'incoming')) && existsSync(join(home, 'd1', 'payload.bin')), existsSync(join(home, 'incoming')) ? readdirSync(join(home, 'incoming')).join(',') : '')
}

section('S6 the agent’s own, the words and the definition')
{
  const theirs = await run({ op: 'download' }, second)
  check('[D3] another agent sees none of them, and nothing was written for it', theirs.result === 'downloads: none — a download that an act starts is saved in the session scratchpad and named in that act’s answer' && pads().every(pad => !existsSync(join(pad, second.agentId ?? '', 'browser-downloads'))), theirs.result)
  const stray = await validate({ op: 'click', selector: '#x', downloadId: 'd1' })
  check('downloadId belongs to download', !stray.ok && stray.message === 'downloadId requires op download', stray.message)
  const both = await validate({ op: 'download', downloadId: 'd1', url: `${A.origin}/` })
  check('download takes one road a call', !both.ok && both.message === 'download takes one of downloadId, url or selector' && (await validate({ op: 'download', url: `${A.origin}/` })).ok && (await validate({ op: 'download', selector: '#dl' })).ok && (await validate({ op: 'download' })).ok, both.message)
  const scheme = await validate({ op: 'download', url: 'file:///etc/hosts' })
  check('an address download takes is one open takes', !scheme.ok && scheme.message === (await validate({ op: 'open', url: 'file:///etc/hosts' })).message, scheme.message)
  check('waiting for a transfer or listing them asks nothing and changes no page: it is a read', BrowserTool.isReadOnly({ op: 'download' } as never) === true && BrowserTool.isReadOnly({ op: 'download', downloadId: 'd1' } as never) === true)
  check('download with an address or a selector is the act it performs', BrowserTool.isReadOnly({ op: 'download', url: `${A.origin}/` } as never) === false && BrowserTool.isReadOnly({ op: 'download', selector: '#dl' } as never) === false)
  const firstVisit = await permission({ op: 'download', url: 'http://127.0.0.1:27299/' })
  const sameAsOpen = await permission({ op: 'open', url: 'http://127.0.0.1:27299/' })
  check('[D1][T7] an address download has not visited asks exactly as open asks', firstVisit.behavior === 'ask' && firstVisit.message === sameAsOpen.message && JSON.stringify(firstVisit.suggestions) === JSON.stringify(sameAsOpen.suggestions), JSON.stringify(firstVisit))
  await run({ op: 'open', url: `${A.origin}/` })
  const allowed = (await permission({ op: 'download', selector: '#dl' })) as { behavior: string; updatedInput?: { op?: string } }
  check('an approved origin asks nothing, and the call that goes on is still the download', allowed.behavior === 'allow' && allowed.updatedInput?.op === 'download', JSON.stringify(allowed))
  const shape = (BrowserTool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape
  check('the definition carries the field in a short clause', shape.downloadId?.description === 'download: wait for this one', String(shape.downloadId?.description))
  const manual: string = await BrowserTool.prompt()
  check('the manual says downloads are followed', manual.includes('\ndownload with url or selector opens or clicks and waits timeoutMs for a file to begin, with downloadId waits for that transfer (call again to go on), alone lists them; a download is saved in the session scratchpad when an act starts it (named in that answer) or it begins later on a tab that was clicked, typed in, selected, pressed or given download (named in the next answer there).\n') && !manual.includes('Downloads and file uploads are not performed here.'), manual.split('\n').find(line => line.startsWith('download')) ?? '')
}

section('S7 what following downloads costs a launch')
{
  interface Sent {
    method: string
    params: Record<string, unknown> | undefined
    session: string | undefined
  }
  const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
  const send = Connection.prototype._rawSend
  let sent: Sent[] = []
  Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
    sent.push({ method: String(method), params: params as Sent['params'], session: typeof session === 'string' ? session : undefined })
    return send.call(this, callbacks, method, params, session, ...rest)
  }
  const unused = join(home, '..', 'never-used')
  const launched = async (agentId: string, follow: boolean): Promise<Sent[]> => {
    sent = []
    const owner = ownerOf({ agentId })
    await sessions.ensureBrowserSession(owner, { origin: B.origin, births: true, ...(follow ? { downloads: { home: unused, claim: () => mkdirSync(unused) } } : {}) })
    const commands = [...sent]
    await sessions.disposeBrowserOwner(owner)
    return commands
  }
  const behaviours = (commands: Sent[]): Sent[] => commands.filter(command => command.method === 'Browser.setDownloadBehavior')
  try {
    const plain = behaviours(await launched('downloads-count-plain', false))
    const all = await launched('downloads-count-followed', true)
    const followed = behaviours(all)
    const watch = all.find(command => command.method === 'Target.setAutoAttach' && JSON.stringify(command.params?.filter) === '[{"type":"page","exclude":false}]')?.session
    check('a launch that does not follow downloads sends the two commands it always sent: the driver’s denial at launch and the page’s with its events', plain.length === 2 && JSON.stringify(plain.map(command => command.params)) === '[{"behavior":"deny"},{"behavior":"deny","eventsEnabled":true}]', JSON.stringify(plain.map(command => command.params)))
    check('a launch that follows them sends no command more: the driver’s denial stays as the floor until the watch names the folder in the page’s place', followed.length === 2 && JSON.stringify(followed[0]?.params) === '{"behavior":"deny"}' && followed[0]?.session !== watch && followed[1]?.session === watch && watch !== undefined && JSON.stringify(followed[1]?.params) === JSON.stringify({ behavior: 'allowAndName', downloadPath: join(unused, 'incoming'), eventsEnabled: true }), JSON.stringify(followed.map(command => [command.session === watch, command.params])))
    check('[G3] and a browser that downloaded nothing wrote nothing', !existsSync(unused))
  } finally {
    Connection.prototype._rawSend = send
  }
}

await finish('prove-browser-downloads', [lead, second, third])
