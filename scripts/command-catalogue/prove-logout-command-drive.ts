#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { recordPty } from '../lib/ptyRecorder.ts'
import { paintsBootFaceReady } from '../lib/bootFace.ts'

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
  console.log('prove-logout-command-drive: requires a POSIX pty')
  process.exit(0)
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

const stripAnsi = (raw: string): string =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-logout-command-drive-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })

const revokeCalls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
const oauthServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/v1/oauth/token/revoke') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      revokeCalls.push({ method: request.method, path: url.pathname, body })
      return Response.json({})
    }
    return Response.json({ error: 'unexpected endpoint' }, { status: 404 })
  },
})
const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }])

const oauthOrigin = `http://127.0.0.1:${oauthServer.port}`
const dead = 'http://127.0.0.1:1'
const BASE_ENV = /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/
const deadBases: Record<string, string> = Object.fromEntries(
  FLAG_REGISTRY.map(row => row.env).filter(name => BASE_ENV.test(name)).map(name => [name, dead]),
)

const far = Date.now() + 365 * 24 * 3600_000
const REFRESH_TOKEN = 'fixture-logout-cmd-refresh'
const credFile = join(home, '.credentials.json')
const secretsFile = join(home, '.provider-secrets.json')
const configFile = join(home, '.mercury.json')

writeFileSync(
  credFile,
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-logout-cmd-access',
      refreshToken: REFRESH_TOKEN,
      expiresAt: far,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  }),
  { mode: 0o600 },
)
writeFileSync(
  secretsFile,
  JSON.stringify({
    openaiApiKey: 'sk-fixture-openai',
    deepseekApiKey: 'fixture-deepseek-key',
    cerebrasApiKey: 'fixture-cerebras-key',
    qwenApiKey: 'fixture-qwen-key',
    qwenKeyBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  }),
  { mode: 0o600 },
)
writeFileSync(
  configFile,
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    projects: {
      [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
    oauthAccount: {
      accountUuid: 'fixture-acct-uuid',
      emailAddress: 'fixture@example.test',
      organizationUuid: 'fixture-org-uuid',
    },
    customApiKeyResponses: { approved: ['fixture-approved-tail'], rejected: [] },
  }),
)
writeFileSync(join(home, 'settings.json'), '{}')

const readJson = (path: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

console.log('============================================================')
console.log(' /logout command — built terminal drive + onboarding clear')
console.log('============================================================')

const env: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERM: 'xterm-256color',
  TMPDIR: process.env.TMPDIR,
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
  ...deadBases,
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_ANTHROPIC_OAUTH_BASE: oauthOrigin,
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CACHE_CLOCK: '0',
  BROWSER: '/usr/bin/true',
}
if (process.env.MERCURY_FEATURE_TRACE) env.MERCURY_FEATURE_TRACE = process.env.MERCURY_FEATURE_TRACE
if (process.env.MERCURY_FEATURE_TRACE_PROOF) env.MERCURY_FEATURE_TRACE_PROOF = process.env.MERCURY_FEATURE_TRACE_PROOF

const pty = recordPty({
  argv: [NODE, DIST],
  cwd,
  env,
  cols: 120,
  rows: 40,
  path: join(scratch, 'logout-pty.bin'),
})

const plainOutput = (): string =>
  stripAnsi(Buffer.concat(pty.records.filter(r => r.direction === 'output').map(r => r.bytes)).toString('utf8'))

const reapDaemon = (): void => {
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

try {
  const bootReady = await waitFor(() => plainOutput().includes('⇧→ concourse') || paintsBootFaceReady(plainOutput()), 30_000)
  check('boot face paints in built terminal', bootReady, plainOutput().slice(-300))

  let chatReady = false
  if (bootReady) {
    await new Promise(r => setTimeout(r, 1500))
    pty.send('\r')
    chatReady = await waitFor(() => plainOutput().includes('Type a prompt'), 6_000)
    if (!chatReady) {
      pty.send('\r')
      chatReady = await waitFor(() => plainOutput().includes('Type a prompt'), 24_000)
    }
  }
  check('chat composer opens from boot face', chatReady, plainOutput().slice(-400))

  if (chatReady) {
    await new Promise(r => setTimeout(r, 800))
    pty.send('/logout')
    await new Promise(r => setTimeout(r, 600))
    pty.send('\r')
    const sawLogout = await waitFor(() => plainOutput().includes('Logged out of all your accounts.'), 4_000)
    if (!sawLogout) {
      try {
        pty.send('\r')
      } catch {
      }
    }
  }
  const exitResult = await Promise.race([
    pty.exited.then(code => ({ done: true as const, code })),
    new Promise<{ done: false; code: null }>(resolveWait => setTimeout(() => resolveWait({ done: false, code: null }), 25_000)),
  ])
  if (!exitResult.done) {
    await pty.close()
  }

  const screen = plainOutput()
  check('/logout paints Logged out of all your accounts.', screen.includes('Logged out of all your accounts.'), screen.slice(-500))
  check('/logout shuts the session down cleanly with exit 0', exitResult.done && exitResult.code === 0, JSON.stringify(exitResult))
  check(
    'revocation endpoint received one POST with the fixture refresh token',
    revokeCalls.length === 1 &&
      revokeCalls[0]?.method === 'POST' &&
      revokeCalls[0]?.body.token === REFRESH_TOKEN &&
      revokeCalls[0]?.body.token_type_hint === 'refresh_token',
    JSON.stringify(revokeCalls.map(c => ({ method: c.method, path: c.path, hint: c.body.token_type_hint, matched: c.body.token === REFRESH_TOKEN }))),
  )
  check('Anthropic credential file is removed', !existsSync(credFile))
  const afterSecrets = readJson(secretsFile)
  const leftKeys = Object.keys(afterSecrets).filter(key => /ApiKey$/.test(key) || key === 'qwenKeyBase')
  check('.provider-secrets.json holds no seeded provider keys after /logout', leftKeys.length === 0, leftKeys.join(', '))
  const afterCfgRaw = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  const afterCfg = readJson(configFile)
  const approvedAfter = (afterCfg.customApiKeyResponses as { approved?: unknown[] } | undefined)?.approved
  check(
    '.mercury.json cleared oauthAccount, reset hasCompletedOnboarding to false, and cleared approved API keys',
    afterCfg.oauthAccount === undefined &&
      afterCfg.hasCompletedOnboarding === false &&
      (approvedAfter === undefined || (Array.isArray(approvedAfter) && approvedAfter.length === 0)) &&
      !afterCfgRaw.includes('fixture-approved-tail'),
    JSON.stringify({
      oauthAccount: afterCfg.oauthAccount,
      hasCompletedOnboarding: afterCfg.hasCompletedOnboarding,
      approved: approvedAfter,
    }),
  )
} finally {
  await pty.close().catch(() => {})
  reapDaemon()
  oauthServer.stop(true)
  await api.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-logout-command-drive (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
