#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { recordPty } from '../lib/ptyRecorder.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const NODE = nodeBinPath()

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (process.platform === 'win32') {
  console.log('prove-auth-mint-drive: requires a POSIX pty')
  process.exit(0)
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

const stripAnsi = (raw: string): string =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(n ? Number(n) : 1))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
const waitFor = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  return false
}

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const FIXTURE_CODE = `fixture-mint-code-${randomBytes(4).toString('hex')}`
const FIXTURE_MINTED = `fixture-mint-oauth-${randomBytes(8).toString('hex')}`

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-auth-mint-drive-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
const urlFile = join(scratch, 'browser-url.txt')
const browserBin = join(scratch, 'fake-browser.sh')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true }))
writeFileSync(join(home, 'settings.json'), '{}')
writeFileSync(browserBin, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(urlFile)}\nexit 0\n`)
chmodSync(browserBin, 0o755)

const tokenRequests: Array<{ grantType: unknown; codeMatched: boolean; state: unknown; expiresIn: unknown }> = []
let profileHits = 0
const oauthServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/v1/oauth/token') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      tokenRequests.push({
        grantType: body.grant_type,
        codeMatched: body.code === FIXTURE_CODE,
        state: body.state,
        expiresIn: body.expires_in,
      })
      return Response.json({
        access_token: FIXTURE_MINTED,
        expires_in: ONE_YEAR_SECONDS,
        scope: 'user:inference',
      })
    }
    if (url.pathname === '/api/oauth/profile') {
      profileHits++
      return Response.json({
        account: { uuid: 'fixture-mint-acct', email: 'fixture-mint@example.test' },
        organization: { uuid: 'fixture-mint-org', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
      })
    }
    return Response.json({ error: 'unexpected endpoint' }, { status: 404 })
  },
})

const oauthOrigin = `http://127.0.0.1:${oauthServer.port}`
const dead = 'http://127.0.0.1:1'
const BASE_ENV = /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/
const deadBases: Record<string, string> = Object.fromEntries(
  ['ANTHROPIC_BASE_URL', ...FLAG_REGISTRY.map(row => row.env).filter(name => BASE_ENV.test(name))].map(name => [name, dead]),
)

const env: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERM: 'xterm-256color',
  TMPDIR: process.env.TMPDIR,
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
  ...deadBases,
  MERCURY_ANTHROPIC_OAUTH_BASE: oauthOrigin,
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  BROWSER: browserBin,
}
if (process.env.MERCURY_FEATURE_TRACE) env.MERCURY_FEATURE_TRACE = process.env.MERCURY_FEATURE_TRACE
if (process.env.MERCURY_FEATURE_TRACE_PROOF) env.MERCURY_FEATURE_TRACE_PROOF = process.env.MERCURY_FEATURE_TRACE_PROOF

const redact = (text: string): string => text.replaceAll(FIXTURE_MINTED, '<redacted-fixture>')

console.log('============================================================')
console.log(' built mercury auth mint — setup-token OAuth flow in a PTY')
console.log('============================================================')

const pty = recordPty({
  argv: [NODE, DIST, 'auth', 'mint'],
  cwd,
  env,
  cols: 120,
  rows: 40,
  path: join(scratch, 'auth-mint-pty.bin'),
})

const plainOutput = (): string =>
  stripAnsi(Buffer.concat(pty.records.filter(r => r.direction === 'output').map(r => r.bytes)).toString('utf8'))

try {
  const openedBrowser = await waitFor(() => existsSync(urlFile) && readFileSync(urlFile, 'utf8').trim().length > 0, 12_000)
  const openedUrlRaw = openedBrowser ? readFileSync(urlFile, 'utf8').trim() : ''
  check(
    'auth mint immediately launches the setup-token browser OAuth flow without stopping at the provider chooser',
    openedBrowser,
    redact(plainOutput().slice(-400)),
  )

  let expectedState = ''
  let callbackStatus = 0
  if (openedBrowser) {
    const parsed = new URL(openedUrlRaw)
    expectedState = parsed.searchParams.get('state') ?? ''
    const redirectUri = parsed.searchParams.get('redirect_uri') ?? ''
    const scope = parsed.searchParams.get('scope') ?? ''
    check(
      'authorize URL rides loopback OAuth base with inference-only scope and S256 PKCE',
      parsed.origin === oauthOrigin &&
        scope === 'user:inference' &&
        parsed.searchParams.get('response_type') === 'code' &&
        parsed.searchParams.get('code_challenge_method') === 'S256' &&
        redirectUri.startsWith('http://localhost:') &&
        redirectUri.endsWith('/callback') &&
        expectedState.length > 0,
      JSON.stringify({ origin: parsed.origin, scope, hasRedirect: redirectUri.endsWith('/callback'), hasState: expectedState.length > 0 }),
    )
    const cbUrl = new URL(redirectUri)
    cbUrl.searchParams.set('code', FIXTURE_CODE)
    cbUrl.searchParams.set('state', expectedState)
    const cbResp = await fetch(cbUrl.toString(), { redirect: 'manual' })
    callbackStatus = cbResp.status
    check('loopback OAuth callback redirects after accepting authorization code', callbackStatus >= 300 && callbackStatus < 400, `status=${callbackStatus}`)
  } else {
    check('authorize URL rides loopback OAuth base with inference-only scope and S256 PKCE', false, 'browser was never opened')
    check('loopback OAuth callback redirects after accepting authorization code', false, 'browser was never opened')
  }

  const exitResult = await Promise.race([
    pty.exited.then(code => ({ done: true as const, code })),
    new Promise<{ done: false; code: null }>(resolveWait => setTimeout(() => resolveWait({ done: false, code: null }), 15_000)),
  ])
  if (!exitResult.done) {
    await pty.close()
  }

  const screen = plainOutput()
  check(
    'token exchange sent authorization_code with 1-year expires_in (31536000)',
    tokenRequests.length === 1 &&
      tokenRequests[0]?.grantType === 'authorization_code' &&
      tokenRequests[0]?.codeMatched === true &&
      tokenRequests[0]?.state === expectedState &&
      tokenRequests[0]?.expiresIn === ONE_YEAR_SECONDS,
    JSON.stringify(tokenRequests.map(r => ({ grantType: r.grantType, codeMatched: r.codeMatched, expiresIn: r.expiresIn }))),
  )
  check('screen paints setup-token heading and one-year creation notice', screen.includes('Set up a long-lived token') && screen.includes('Token created. It is valid for one year.'), redact(screen.slice(-500)))
  check('screen paints the minted fixture value and MERCURY_OAUTH_TOKEN guidance', screen.includes(FIXTURE_MINTED) && /It will not be shown again\s*—\s*store it now\./.test(screen) && screen.includes('Export it as MERCURY_OAUTH_TOKEN to use it.'), redact(screen.slice(-500)))
  check('auth mint exits cleanly with code 0 after printing the minted token', exitResult.done && exitResult.code === 0, JSON.stringify(exitResult))
  check('auth mint does not write a stored credential file to the config home', !existsSync(join(home, '.credentials.json')) && profileHits <= 1)
} finally {
  await pty.close().catch(() => {})
  oauthServer.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-auth-mint-drive (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
