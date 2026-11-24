#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const { ROOT, check, finish, lead, pageOf, permission, requireBrowser, run, section, serve } = await import('./harness.ts')

await requireBrowser()
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

let originBClicks = 0
let originBKeys = 0
const B = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  if (path === '/hit-click') {
    originBClicks++
    res.writeHead(204)
    res.end()
    return
  }
  if (path === '/hit-key') {
    originBKeys++
    res.writeHead(204)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(
    '<!doctype html><style>html,body{margin:0;padding:0;width:100%;height:100%}</style>' +
    '<button id="btn" style="position:fixed;left:0;top:0;width:300px;height:200px" onclick="fetch(\'/hit-click\');document.getElementById(\'inp\').focus()">confirm</button>' +
    '<input id="inp" style="position:fixed;left:10px;top:10px;width:10px;height:10px" onkeydown="if(event.key===\'Enter\')fetch(\'/hit-key\')">',
  )
})
const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(
    `<!doctype html><title>host-a</title><style>html,body{margin:0;padding:0}</style><iframe id="f" src="${B.origin}/framed" style="position:fixed;left:0;top:0;width:300px;height:200px;border:0"></iframe>`,
  )
})

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await new Promise(done => setTimeout(done, 50))
  }
  return ok()
}

const resolved: { executablePath: string } = resolveBrowser()
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-o10-'))
const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank']
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox')
const user: ChildProcess = spawn(resolved.executablePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
const socket = await new Promise<string>((done, fail) => {
  let seen = ''
  const lapse = setTimeout(() => fail(new Error(`fixture Chromium never printed its debugging address: ${seen.slice(-400)}`)), 30_000)
  user.stderr?.on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8')
    const hit = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
    if (hit === null) return
    clearTimeout(lapse)
    done(hit[1]!)
  })
  user.once('exit', code => fail(new Error(`fixture Chromium exited (${code}) before listening: ${seen.slice(-400)}`)))
})
const endpoint = `http://127.0.0.1:${new URL(socket).port}`

await fetch(`${endpoint}/json/new?${A.origin}/host`, { method: 'PUT' })
await until(async () => {
  const list = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{ type: string; url: string }>
  return list.some(t => t.type === 'page' && t.url.startsWith(`${A.origin}/host`))
})

try {
  section('O-10: coordinate click and press on an approved page must not act inside an unapproved cross-origin iframe')
  const joined = await run({ op: 'attach', endpoint })
  const tabA = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(l => l.includes(`${A.origin}/host`)) ?? '')?.[1] ?? 'tab-missing'
  await permission({ op: 'extract', tab: tabA })
  await run({ op: 'extract', tab: tabA })
  const frameReady = await until(() => pageOf(lead, tabA).frames().some(f => f.url().startsWith(`${B.origin}/framed`)), 5000)
  check('setup: unapproved cross-origin iframe B is loaded inside approved page A', frameReady)

  const clickPerm = await permission({ op: 'click', tab: tabA, x: 150, y: 100 })
  const clickRes = clickPerm.behavior === 'allow' ? await run({ op: 'click', tab: tabA, x: 150, y: 100 }) : { outcome: 'refused-by-perm', result: clickPerm.message ?? '' }
  await new Promise(done => setTimeout(done, 250))
  check(
    'coordinate click at (150, 100) must ask for origin B or be refused before clicking inside unapproved iframe B',
    clickPerm.behavior !== 'allow' || (clickRes.outcome === 'failed' && originBClicks === 0),
    `perm=${clickPerm.behavior} outcome=${clickRes.outcome} originBClicks=${originBClicks} result=${clickRes.result}`,
  )

  await pageOf(lead, tabA).mouse.click(150, 100)
  const focused = await until(() => originBClicks === 1, 3000)
  check('setup: the user clicked inside iframe B, so the focus sits in B', focused && originBKeys === 0, `originBClicks=${originBClicks}`)

  const pressPerm = await permission({ op: 'press', tab: tabA, key: 'Enter' })
  const pressRes = pressPerm.behavior === 'allow' ? await run({ op: 'press', tab: tabA, key: 'Enter' }) : { outcome: 'refused-by-perm', result: pressPerm.message ?? '' }
  await new Promise(done => setTimeout(done, 250))
  check(
    'press Enter while focus sits inside unapproved iframe B must ask for origin B or be refused before delivering key to B',
    pressPerm.behavior !== 'allow' || (pressRes.outcome === 'failed' && originBKeys === 0),
    `perm=${pressPerm.behavior} outcome=${pressRes.outcome} originBKeys=${originBKeys} result=${pressRes.result}`,
  )

  section('the ask is for the frame that takes the act, a yes lets it land, and the page itself asks nothing more')
  check('the click asks for origin B by name', clickPerm.behavior === 'ask' && (clickPerm.message ?? '').includes(`on ${B.origin} in tab ${tabA}`), `${clickPerm.behavior}: ${clickPerm.message ?? ''}`)
  check('the key press asks for origin B by name', pressPerm.behavior === 'ask' && (pressPerm.message ?? '').includes(`on ${B.origin} in tab ${tabA}`), `${pressPerm.behavior}: ${pressPerm.message ?? ''}`)
  const beside = await permission({ op: 'click', tab: tabA, x: 600, y: 400 })
  check('a click at a point of the approved page itself asks nothing', beside.behavior === 'allow', `${beside.behavior}: ${beside.message ?? ''}`)
  const clicksBefore = originBClicks
  await permission({ op: 'click', tab: tabA, x: 150, y: 100 })
  const landed = await run({ op: 'click', tab: tabA, x: 150, y: 100 })
  const counted = await until(() => originBClicks === clicksBefore + 1, 3000)
  check('approved, the click lands inside iframe B', landed.outcome === 'succeeded' && counted, `outcome=${landed.outcome} originBClicks=${originBClicks} result=${landed.result}`)
  const again = await permission({ op: 'press', tab: tabA, key: 'Enter' })
  const keyed = again.behavior === 'allow' ? await run({ op: 'press', tab: tabA, key: 'Enter' }) : { outcome: 'asked-again', result: again.message ?? '' }
  const keyCounted = await until(() => originBKeys === 1, 3000)
  check('and origin B, once approved, takes the key without a second ask', again.behavior === 'allow' && keyed.outcome === 'succeeded' && keyCounted, `perm=${again.behavior} outcome=${keyed.outcome} originBKeys=${originBKeys}`)

  await run({ op: 'close' })
} finally {
  if (user.exitCode === null) user.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-coord-cross-origin-frame', [lead])
