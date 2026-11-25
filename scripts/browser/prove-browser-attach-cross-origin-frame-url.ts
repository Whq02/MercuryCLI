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

const B = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  if (path === '/start') {
    res.writeHead(302, { location: '/callback?code=SECRET_OAUTH_CODE#access_token=SECRET_FRAG', 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end("<!doctype html><title>cb</title><p>iframe secret body</p><script>console.log('SECRET_FROM_ORIGIN_B')</script>")
})
const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>host-a</title><p>parent text</p><iframe id="f" src="${B.origin}/start"></iframe>`)
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
const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-o13-'))
const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--use-mock-keychain', '--password-store=basic', '--no-default-browser-check', 'about:blank']
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
  section('O-13 part (a): extract on an approved parent must not expose unapproved cross-origin iframe query/fragment URL')
  const joined = await run({ op: 'attach', endpoint })
  const tabA = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(l => l.includes(`${A.origin}/host`)) ?? '')?.[1] ?? 'tab-missing'
  const redirected = await until(() => pageOf(lead, tabA).frames().some(f => f.url().includes('/callback')), 5000)
  check('setup: unapproved iframe B completed redirect to /callback', redirected)

  await permission({ op: 'extract', tab: tabA })
  const text = await run({ op: 'extract', tab: tabA })
  check('setup: extract on approved origin A returned parent text', text.outcome !== 'failed' && text.result.includes('parent text'), text.result)
  check(
    'extract Frames listing does not leak unapproved cross-origin iframe query or fragment',
    !text.result.includes('SECRET_OAUTH_CODE') && !text.result.includes('SECRET_FRAG'),
    text.result,
  )

  await run({ op: 'close' })
} finally {
  if (user.exitCode === null) user.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-cross-origin-frame-url', [lead])
