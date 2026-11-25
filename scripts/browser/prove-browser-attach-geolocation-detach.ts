#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { removeScratch } from '../lib/removeScratch.ts'

const { ROOT, check, finish, lead, pageOf, permission, requireBrowser, run, section, serve } = await import('./harness.ts')

await requireBrowser()
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>geo-a</title><p>origin A</p>')
})
const B = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>geo-b</title><p>origin B</p>')
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
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-o12-'))
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

await fetch(`${endpoint}/json/new?${A.origin}/geo`, { method: 'PUT' })
await until(async () => {
  const list = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{ type: string; url: string }>
  return list.some(t => t.type === 'page' && t.url.startsWith(`${A.origin}/geo`))
})

let desk: Awaited<ReturnType<typeof puppeteer.connect>> | null = null
try {
  section('O-12: geolocation permission granted during attached emulation must not persist after detach or spread to unapproved origins')
  const joined = await run({ op: 'attach', endpoint })
  const tabA = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(l => l.includes(`${A.origin}/geo`)) ?? '')?.[1] ?? 'tab-missing'
  await permission({ op: 'extract', tab: tabA })
  await run({ op: 'extract', tab: tabA })

  await permission({ op: 'viewport', tab: tabA, emulation: { geolocation: { latitude: 12.34, longitude: 56.78 } } })
  const em = await run({ op: 'viewport', tab: tabA, emulation: { geolocation: { latitude: 12.34, longitude: 56.78 } } })
  const stateABefore = await pageOf(lead, tabA).evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
  check('setup: geolocation emulation succeeded and granted origin A while attached', em.outcome === 'succeeded' && stateABefore === 'granted', `stateABefore=${stateABefore} em=${em.result}`)

  await pageOf(lead, tabA).goto(`${B.origin}/other`)
  await new Promise(done => setTimeout(done, 200))
  const stateBWhileAttached = await pageOf(lead, tabA).evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
  check('while attached, navigating to unapproved origin B must not silently grant geolocation to B', stateBWhileAttached !== 'granted', `stateBWhileAttached=${stateBWhileAttached}`)
  await pageOf(lead, tabA).goto(`${A.origin}/geo`)
  await new Promise(done => setTimeout(done, 200))

  const detached = await run({ op: 'close' })
  check('setup: detached cleanly from attached browser', detached.outcome === 'succeeded' && detached.result.startsWith('detached from'), detached.result)

  desk = await puppeteer.connect({ browserWSEndpoint: socket, defaultViewport: null })
  const pages = await desk.pages()
  const pageA = pages.find(p => p.url().startsWith(`${A.origin}/geo`))
  check('setup: user tab on origin A is still open after detach', pageA !== undefined)
  if (pageA !== undefined) {
    const stateA = await pageA.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
    console.log(`  observed after detach: stateA=${stateA}`)
    check('after detach, origin A no longer holds granted geolocation permission in user Chromium', stateA !== 'granted', `stateA=${stateA}`)
    await pageA.goto(`${B.origin}/other`)
    const stateB = await pageA.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
    console.log(`  observed after detach: stateB=${stateB}`)
    check('after detach, unapproved origin B does not hold granted geolocation permission', stateB !== 'granted', `stateB=${stateB}`)
  }
} finally {
  if (desk !== null) await desk.disconnect().catch(() => undefined)
  if (user.exitCode === null) user.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-geolocation-detach', [lead])
