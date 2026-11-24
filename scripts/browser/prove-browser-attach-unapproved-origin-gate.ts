#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const { ROOT, check, finish, lead, ownerOf, pageOf, permission, requireBrowser, run, section, serve, sessions } = await import('./harness.ts')

await requireBrowser()
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>approved-page</title><p>approved origin content</p>')
})
const B = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>bank-popup</title><p>BANK_SECRET_TEXT</p>')
})
const C = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>framed-bank</title><p>FRAMED_SECRET_TEXT</p>')
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
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-o05-'))
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
const port = Number(new URL(socket).port)
const endpoint = `http://127.0.0.1:${port}`

await fetch(`${endpoint}/json/new?${A.origin}/home`, { method: 'PUT' })
await until(async () => {
  const list = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{ type: string; url: string }>
  return list.some(t => t.type === 'page' && t.url.startsWith(`${A.origin}/home`))
})

try {
  const joined = await run({ op: 'attach', endpoint })
  const tabA = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(l => l.includes(`${A.origin}/home`)) ?? '')?.[1] ?? 'tab-missing'
  const initialCount = (sessions.browserTabs(ownerOf(lead)) as Array<{ tab: string }>).length
  const nextTab = `tab-${initialCount + 1}`

  await permission({ op: 'extract', tab: tabA })
  const approvedA = await run({ op: 'extract', tab: tabA })
  check('setup: approved origin A reads normally', approvedA.outcome !== 'failed' && approvedA.result.includes('approved origin content'), approvedA.result)

  section('O-05 Path A: tab not yet adopted during checkPermissions cannot be read or approved on call')
  {
    await permission({ op: 'extract', tab: nextTab })
    await pageOf(lead, tabA).evaluate((url: string) => {
      window.open(url, '_blank')
    }, `${B.origin}/secret`)
    const adopted = await until(() => {
      const live = sessions.activeSession(ownerOf(lead), nextTab) as { page: { url(): string } } | null
      return live !== null && live.page.url().startsWith(`${B.origin}/secret`)
    }, 8000)
    check('setup: popup adopted as predicted next tab on unapproved origin B', adopted, `nextTab=${nextTab}`)
    const leaked = await run({ op: 'extract', tab: nextTab })
    check(
      'unapproved popup tab is refused when checkPermissions saw no session for it',
      leaked.outcome === 'failed' && !leaked.result.includes('BANK_SECRET_TEXT'),
      `outcome=${leaked.outcome} result=${leaked.result.slice(0, 240)}`,
    )
    check(
      'unapproved popup origin B is not silently added to approvedOrigins',
      !sessions.originApproved(ownerOf(lead), B.origin),
      `approvedOrigins=${JSON.stringify(sessions.approvedOriginList(ownerOf(lead)))}`,
    )
  }

  section('O-05 Path B: frame absent during checkPermissions cannot be read or approved when it appears before call')
  {
    await permission({ op: 'extract', tab: tabA, frame: 1 })
    await pageOf(lead, tabA).evaluate((url: string) => {
      const el = document.createElement('iframe')
      el.src = url
      document.body.appendChild(el)
    }, `${C.origin}/framed-secret`)
    const loaded = await until(() => {
      const frames = pageOf(lead, tabA).frames().filter(f => f.parentFrame() !== null)
      return frames.length === 1 && frames[0]!.url().startsWith(`${C.origin}/framed-secret`)
    }, 8000)
    check('setup: cross-origin iframe of unapproved origin C loaded after checkPermissions', loaded)
    const leaked = await run({ op: 'extract', tab: tabA, frame: 1 })
    check(
      'unapproved child frame is refused when targetOrigin failed during checkPermissions',
      leaked.outcome === 'failed' && !leaked.result.includes('FRAMED_SECRET_TEXT'),
      `outcome=${leaked.outcome} result=${leaked.result.slice(0, 240)}`,
    )
    check(
      'unapproved frame origin C is not silently added to approvedOrigins',
      !sessions.originApproved(ownerOf(lead), C.origin),
      `approvedOrigins=${JSON.stringify(sessions.approvedOriginList(ownerOf(lead)))}`,
    )
  }

  await run({ op: 'close' })
} finally {
  if (user.exitCode === null) user.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-unapproved-origin-gate', [lead])
