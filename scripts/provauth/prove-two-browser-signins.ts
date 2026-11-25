#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'

const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of Object.keys(process.env)) {
  if (ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) || /proxy/i.test(name)) delete process.env[name]
}

const fixHint = 'the listeners are beginOpenaiBrowserConnect in src/models/roads/openai/openaiAccounts.ts and runGoogleLoopbackConnect in src/models/roads/gemini/geminiAccounts.ts (on a port that is taken: no browser, the words handed to onListenerIssue); the sign-in each process runs is scripts/provauth/lib/browser-signin-child.ts and the stand-in provider is the Bun.serve block of this file'
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const jwt = (payload: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

const exchanged: string[] = []
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && (path === '/oauth/token' || path === '/token')) {
      const form = Object.fromEntries(new URLSearchParams(await request.text()).entries())
      if (form.grant_type !== 'authorization_code' || !form.code) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      exchanged.push(form.code)
      return Response.json({
        token_type: 'Bearer',
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, code: form.code }),
        id_token: jwt({ email: `${form.code}@example.invalid`, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${form.code}`, chatgpt_plan_type: 'plus' } }),
        refresh_token: `rt-of-${form.code}`,
        expires_in: 3600,
      })
    }
    if (path === '/oauth2/v1/userinfo') return Response.json({ email: 'plan@example.invalid' })
    if (path.endsWith(':loadCodeAssist')) return Response.json({ currentTier: { id: 'free-tier', name: 'Free' }, allowedTiers: [{ id: 'free-tier', name: 'Free', isDefault: true }], cloudaicompanionProject: 'project-fixture-123' })
    return new Response(null, { status: 404 })
  },
})
const base = `http://127.0.0.1:${provider.port}`
const opened = join(proofHome, 'opened-in-the-browser.txt')
const browser = join(proofHome, 'stand-in-browser.sh')
writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 })
const homes = [join(proofHome, 'profile-1'), join(proofHome, 'profile-2')] as const
for (const home of homes) mkdirSync(home)
const sharedEnv = {
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  BROWSER: browser,
  MERCURY_OPENAI_AUTH_BASE: base,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/token`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/auth`,
  MERCURY_GOOGLE_USERINFO_BASE: base,
  MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE: base,
  MERCURY_ANTIGRAVITY_MANIFEST_BASE: base,
  MERCURY_GEMINI_OAUTH_CLIENT_ID: 'client-fixture.apps.googleusercontent.com',
}

type Begun = { authorizeUrl: string; bound: number | null; issue: string | null }
type Ended = { ok: boolean; account?: string; error?: string; stored?: string }
interface SignIn {
  begun: Promise<Begun>
  ended: Promise<Ended>
  paste(redirected: string): void
}
function signIn(road: string, port: number, home: string): SignIn {
  const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'browser-signin-child.ts'), road, String(port)], { env: { ...process.env, ...sharedEnv, MERCURY_CONFIG_DIR: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let begin: (value: Begun) => void = () => {}
  let end: (value: Ended) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const begun = new Promise<Begun>((resolve, reject) => { begin = resolve; fail = reject })
  const ended = new Promise<Ended>(resolve => { end = resolve })
  const lineAbout = (about: string): string | undefined => out.split('\n').find(line => line.startsWith(`{"about":"${about}"`) && line.endsWith('}'))
  proc.stdout.on('data', chunk => {
    out += String(chunk)
    const started = lineAbout('begun')
    if (started) begin(JSON.parse(started) as Begun)
    const finished = lineAbout('ended')
    if (finished) end(JSON.parse(finished) as Ended)
  })
  proc.stderr.on('data', chunk => { err += String(chunk) })
  const overdue = setTimeout(() => proc.kill('SIGKILL'), 60_000)
  proc.on('close', code => {
    clearTimeout(overdue)
    fail(new Error(`the sign-in process ended rc=${code} before it began: ${out.slice(-300)} ${err.slice(-300)}`))
    end({ ok: false, error: `the sign-in process ended rc=${code}: ${out.slice(-300)} ${err.slice(-300)}` })
  })
  return { begun, ended, paste: redirected => { proc.stdin.write(`${redirected}\n`) } }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}
const openedUrls = (): string[] => (existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : [])
const stateOf = (address: string): string => new URL(address).searchParams.get('state') ?? ''

async function twoSignInsAtOnce(road: string, name: string, registered: string, storedOf: (code: string) => string): Promise<void> {
  console.log(`── ${name}: two profiles begin the browser sign-in at once on the one port the provider knows (${registered}) ──`)
  const port = await freePort()
  const callback = new URL(registered).pathname
  const first = signIn(road, port, homes[0])
  const one = await first.begun
  const second = signIn(road, port, homes[1])
  const two = await second.begun
  check(`${name}: the first profile owns the listener`, one.bound === port && one.issue === null, JSON.stringify(one))
  check(`${name}: the second finds the port taken and is told so in the paste road's own words`, two.bound === null && /^loopback listener unavailable \(.+\) — finish by pasting the redirected URL$/.test(two.issue ?? ''), JSON.stringify({ bound: two.bound, issue: two.issue }))
  await sleep(500)
  const browsed = openedUrls().map(stateOf)
  check(`${name}: the browser was opened for the first profile, which owns the listener`, browsed.includes(stateOf(one.authorizeUrl)), `${browsed.length} addresses opened`)
  check(`${name}: no browser was opened for the second, whose answer would land on a listener it does not own`, !browsed.includes(stateOf(two.authorizeUrl)), 'the stand-in browser was started with the second profile\'s address')
  const page = await fetch(`http://127.0.0.1:${port}${callback}?code=${road}-code-1&state=${stateOf(one.authorizeUrl)}`)
  const oneEnd = await first.ended
  check(`${name}: the first profile signs in through its own listener`, page.status === 200 && oneEnd.ok && oneEnd.stored === storedOf(`${road}-code-1`), JSON.stringify({ page: page.status, ...oneEnd }))
  second.paste(`${registered}?code=${road}-code-2&state=${stateOf(two.authorizeUrl)}`)
  const twoEnd = await second.ended
  check(`${name}: the second signs in by pasting the redirected address`, twoEnd.ok && twoEnd.stored === storedOf(`${road}-code-2`), JSON.stringify(twoEnd))
  check(`${name}: each code was exchanged once, by the profile it was given to`, exchanged.filter(code => code.startsWith(`${road}-code-`)).sort().join(',') === `${road}-code-1,${road}-code-2`, exchanged.join(','))
}

try {
  await twoSignInsAtOnce('openai', 'OpenAI', 'http://localhost:1455/auth/callback', code => `rt-of-${code}`)
  await twoSignInsAtOnce('gemini-oauth', 'Google (your own OAuth client)', 'http://127.0.0.1:1457/oauth2/callback', code => `rt-of-${code}`)
  await twoSignInsAtOnce('gemini-plan', 'Google (the plan sign-in)', 'http://127.0.0.1:51121/oauth-callback', code => `rt-of-${code}`)
} finally {
  void provider.stop(true)
}
console.log(failures === 0 ? `\nTWO BROWSER SIGN-INS GREEN (${passes} checks; two real processes a road, each in its own home, a loopback provider, a stand-in browser, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
