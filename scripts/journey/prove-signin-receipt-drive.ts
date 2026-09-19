#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = path.resolve(argAfter('--dist') ?? path.join(REPO, 'dist/mercury.mjs'))
const FRAMES = argAfter('--frames')
const LABEL = argAfter('--label') ?? 'signin'
const SIZE = argAfter('--size') ?? '120x40'
const LEG = argAfter('--leg') ?? 'both'
const WORLD_ROOT = argAfter('--world') ?? realpathSync(tmpdir())
const KEEP = process.argv.includes('--keep')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const FIRST_EMAIL = 'first@fixture.example'
const SECOND_EMAIL = 'second@fixture.example'
const FIRST_ACCESS = 'fixture-first-access-token-0001'
const SECOND_ACCESS = 'fixture-second-access-token-0002'
const DEAD = 'http://127.0.0.1:9'
const FULL_LAYOUT = COLS >= 100 && ROWS >= 26

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (label: string, detail: string): void => {
  console.log(`  [record] ${label}: ${detail}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

if (!existsSync(DIST)) {
  console.log(`FAIL ${DIST} missing — build first (the drive proves the BUILT binary)`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`SKIP the drive needs the POSIX capture engine: ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
type Payload = { grid: Grid; marks?: Mark[]; endReason?: string }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
const tail = (text: string, lines: number): string => text.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')
const markText = (payload: Payload | null, label: string): string => {
  const mark = payload?.marks?.find(m => m.label === label)
  return mark === undefined ? '' : gridText(mark.grid)
}

function startOauthFixture(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    const url = req.url ?? ''
    hits.push(`${req.method ?? ''} ${url}${bearer ? ` bearer=${bearer}` : ''}`)
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'POST' && url.startsWith('/v1/oauth/token')) {
        json(200, {
          access_token: SECOND_ACCESS,
          refresh_token: 'fixture-second-refresh-token-0002',
          expires_in: 3600,
          scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
          account: { uuid: 'uuid-second-account', email_address: SECOND_EMAIL },
          organization: { uuid: 'org-second' },
        })
        return
      }
      if (req.method === 'GET' && url.startsWith('/api/oauth/profile')) {
        const second = bearer === SECOND_ACCESS
        json(200, {
          account: {
            uuid: second ? 'uuid-second-account' : 'uuid-first-account',
            email: second ? SECOND_EMAIL : FIRST_EMAIL,
            display_name: second ? 'Second Account' : 'First Account',
            created_at: '2025-01-01T00:00:00Z',
          },
          organization: {
            uuid: second ? 'org-second' : 'org-first',
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_5x',
            billing_type: 'stripe_subscription',
            subscription_created_at: '2025-01-01T00:00:00Z',
          },
        })
        return
      }
      if (url.startsWith('/api/oauth/claude_cli/roles')) {
        json(200, { organization_role: 'admin', workspace_role: 'workspace_admin', organization_name: bearer === SECOND_ACCESS ? 'Second Org' : 'First Org' })
        return
      }
      json(404, {})
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ port, hits, close: () => server.close() })
    })
  })
}

function seedHome(runHome: string, fixtureCwd: string): { browser: string; opens: string } {
  rmSync(runHome, { recursive: true, force: true })
  mkdirSync(fixtureCwd, { recursive: true })
  writeFileSync(
    path.join(runHome, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [fixtureCwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
      oauthAccount: {
        accountUuid: 'uuid-first-account',
        emailAddress: FIRST_EMAIL,
        organizationUuid: 'org-first',
        organizationName: 'First Org',
        displayName: 'First Account',
        billingType: 'stripe_subscription',
        accountCreatedAt: '2025-01-01T00:00:00Z',
        subscriptionCreatedAt: '2025-01-01T00:00:00Z',
      },
    }),
  )
  writeFileSync(path.join(runHome, 'settings.json'), '{}')
  writeFileSync(
    path.join(runHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FIRST_ACCESS,
        refreshToken: 'fixture-first-refresh-token-0001',
        expiresAt: 4102444800000,
        scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    path.join(runHome, '.sign-ins.json'),
    JSON.stringify({ version: 1, signIns: { anthropic: { at: Date.now() - 60_000, kind: 'oauth' } } }),
    { mode: 0o600 },
  )
  writeFileSync(path.join(fixtureCwd, 'README.md'), '# sign-in receipt drive fixture\n')
  const opens = path.join(runHome, 'browser-opens.log')
  const browser = path.join(runHome, 'fixture-browser.sh')
  writeFileSync(
    browser,
    [
      '#!/bin/bash',
      'url="$1"',
      `printf '%s\\n' "$url" >> "${opens}"`,
      `port=$(printf '%s' "$url" | sed -n 's/.*redirect_uri=http%3A%2F%2Flocalhost%3A\\([0-9]*\\)%2Fcallback.*/\\1/p')`,
      `state=$(printf '%s' "$url" | sed -n 's/.*[?&]state=\\([^&]*\\).*/\\1/p')`,
      '( sleep 1; /usr/bin/curl -s -o /dev/null "http://localhost:${port}/callback?code=fixture-authorization-code&state=${state}" ) >/dev/null 2>&1 &',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(browser, 0o755)
  return { browser, opens }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function endOwnedDaemon(runHome: string): Promise<string> {
  const recordFile = path.join(runHome, 'daemon', 'supervisor.json')
  if (!existsSync(recordFile)) return 'no daemon record'
  let pid = 0
  try {
    pid = Number((JSON.parse(readFileSync(recordFile, 'utf8')) as { pid?: number }).pid ?? 0)
  } catch {
    return 'daemon record unreadable'
  }
  if (!Number.isInteger(pid) || pid <= 1) return 'daemon record carries no pid'
  for (let waited = 0; waited < 10_000 && pidAlive(pid); waited += 250) await sleep(250)
  if (!pidAlive(pid)) return `the owned daemon (pid ${pid}) reaped itself after the cockpit exited`
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
  }
  for (let waited = 0; waited < 5_000 && pidAlive(pid); waited += 250) await sleep(250)
  if (!pidAlive(pid)) return `the owned daemon (pid ${pid}) was asked to stop and did`
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
  }
  return `the owned daemon (pid ${pid}) had to be killed`
}

function leftoverPids(runHome: string): number[] {
  const out = spawnSync('/usr/bin/pgrep', ['-f', runHome], { encoding: 'utf8' }).stdout ?? ''
  return out
    .split('\n')
    .map(l => Number(l.trim()))
    .filter(n => Number.isInteger(n) && n > 1 && n !== process.pid)
}

type Send = Record<string, unknown>

const composerGate = { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 6 }

function chatSends(): Send[] {
  return [
    { atTick: 90, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'face' },
    { minTick: 10, ...composerGate, data: '/logins anthropic', mark: 'composer' },
    { afterPrevTicks: 4, data: '\r' },
    { atTick: 320, awaitText: 'Sign in', awaitSettleTicks: 3, data: '\r', mark: 'menu' },
    { atTick: 560, awaitText: 'Signed in as', awaitSettleTicks: 5, data: '\r', mark: 'pane' },
    { atTick: 640, awaitText: 'Login successful', awaitSettleTicks: 4, data: '/status', mark: 'receipt' },
    { afterPrevTicks: 4, data: '\r' },
  ]
}

function faceSends(): Send[] {
  const down = (mark?: string): Send => ({ afterPrevTicks: 2, data: '\x1b[B', ...(mark ? { mark } : {}) })
  return [
    { atTick: 90, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\x1b[B', mark: 'face-before' },
    down(),
    down(),
    down(),
    down(),
    down(),
    { afterPrevTicks: 3, data: '\r' },
    { atTick: 260, awaitText: 'CONTROL PLANE', awaitSettleTicks: 4, data: '\r', mark: 'roster-before' },
    { atTick: 520, awaitText: 'Signed in as', awaitSettleTicks: 5, data: '\r', mark: 'pane' },
    { afterPrevTicks: 8, data: '', mark: 'roster' },
    { afterPrevTicks: 2, data: '\x1b' },
  ]
}

async function runLeg(leg: 'chat' | 'face'): Promise<{
  payload: Payload | null
  status: number | null
  home: string
  hits: string[]
  opens: string
  stderr: string
  daemon: string
  storedEmail: string | undefined
  storedToken: string | undefined
}> {
  const RUN_HOME = path.join(WORLD_ROOT, `mercury-signin-receipt-${leg}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const seeded = seedHome(RUN_HOME, FIXTURE_CWD)
  const fixture = await startOauthFixture()
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: [NODE, DIST, '--model', 'claude-opus-5'],
    cwd: FIXTURE_CWD,
    sends: leg === 'chat' ? chatSends() : faceSends(),
    readyText: leg === 'chat' ? ['Mercury — status'] : ['↑↓ choose'],
    readySettleTicks: 6,
    stableTicks: 8,
    total: 800,
    cols: COLS,
    rows: ROWS,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CUSTOM_OAUTH_URL: `http://127.0.0.1:${fixture.port}`,
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: DEAD,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: DEAD,
    MERCURY_ZAI_API_BASE: DEAD,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    BROWSER: seeded.browser,
  }
  for (const key of [
    'NODE_ENV',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'HF_TOKEN',
    'MERCURY_COMPAT_BASE_URL',
    'MERCURY_LOCAL_BASE_URL',
    'MERCURY_LOCAL_API_KEY',
    'MERCURY_HUGGINGFACE_BILL_TO',
    'MERCURY_AUTH_SCOPE_DIR',
    'MERCURY_HOME',
    'MERCURY_RENDER_THEME',
    'MERCURY_THEME_PIN',
    'VSHOT_ACTIVE',
  ]) {
    delete childEnv[key]
  }
  const capture = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
    cwd: FIXTURE_CWD,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let captureStderr = ''
  capture.stderr.on('data', (chunk: Buffer) => {
    captureStderr += chunk.toString('utf8')
  })
  capture.stdout.on('data', () => {})
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => {
      captureStderr += '\nthe capture wall was reached; the engine was killed'
      capture.kill('SIGKILL')
    }, vshotBudgetMs(240_000))
    capture.on('exit', code => {
      clearTimeout(wall)
      resolve(code)
    })
  })
  fixture.close()
  const daemon = await endOwnedDaemon(RUN_HOME)
  const leftovers = leftoverPids(RUN_HOME)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
    }
  }
  let payload: Payload | null = null
  if (existsSync(out)) payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
  if (FRAMES !== undefined && payload !== null) {
    mkdirSync(FRAMES, { recursive: true })
    for (const mark of payload.marks ?? []) writeFileSync(path.join(FRAMES, `${LABEL}-${leg}-${mark.label}-${COLS}x${ROWS}.txt`), gridText(mark.grid))
    writeFileSync(path.join(FRAMES, `${LABEL}-${leg}-end-${COLS}x${ROWS}.txt`), gridText(payload.grid))
  }
  let storedEmail: string | undefined
  let storedToken: string | undefined
  try {
    const cfgOnFile = JSON.parse(readFileSync(path.join(RUN_HOME, '.mercury.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string } }
    storedEmail = cfgOnFile.oauthAccount?.emailAddress
  } catch {
  }
  try {
    const creds = JSON.parse(readFileSync(path.join(RUN_HOME, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string } }
    storedToken = creds.claudeAiOauth?.accessToken
  } catch {
  }
  let opens = ''
  try {
    opens = readFileSync(seeded.opens, 'utf8')
  } catch {
  }
  return {
    payload,
    status,
    home: RUN_HOME,
    hits: fixture.hits,
    opens,
    stderr: `${captureStderr}${leftovers.length > 0 ? `\nleftover pids ended: ${leftovers.join(',')}` : ''}`,
    daemon,
    storedEmail,
    storedToken,
  }
}

console.log('============================================================')
console.log(' the Anthropic sign-in names the account that just signed in — the real binary, one stored account, a sign-in as another')
console.log(`   dist: ${DIST}`)
console.log(`   size: ${COLS}x${ROWS} (${FULL_LAYOUT ? 'full' : 'compact'} layout) · leg: ${LEG}`)
console.log('============================================================')

const kept: string[] = []

if (LEG === 'chat' || LEG === 'both') {
  section('the chat road: /logins anthropic, the loopback sign-in lands the second account, the pane, the receipt, /status')
  const r = await runLeg('chat')
  const pane = markText(r.payload, 'pane')
  const receipt = markText(r.payload, 'receipt')
  const end = r.payload === null ? '' : gridText(r.payload.grid)
  record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} · ${r.daemon}`)
  record('fixture hits', r.hits.join(' | ') || 'none')
  record('browser opens', r.opens.trim().split('\n').length + ' url(s)')
  record('the pane line', JSON.stringify(pane.split('\n').find(l => l.includes('Signed in')) ?? null))
  check('the browser opener was handed the authorize url and the loopback callback completed the flow', r.opens.includes('/oauth/authorize') && r.hits.some(h => h.startsWith('POST /v1/oauth/token')), r.stderr.slice(-600))
  check('the sign-in read the profile with the token the exchange minted, never the stored one', r.hits.some(h => h.startsWith('GET /api/oauth/profile') && h.includes(`bearer=${SECOND_ACCESS}`)), r.hits.join(' | '))
  check('the success pane names the account that just signed in', pane.includes(`Signed in as ${SECOND_EMAIL}`), tail(pane, 14) || r.stderr.slice(-600))
  check('the success pane never names the account stored before the switch', pane !== '' && !pane.includes(FIRST_EMAIL), tail(pane, 14))
  check('the chat receipt lands after the pane is confirmed', receipt.includes('Login successful'), tail(receipt, 10))
  check('the credential on file is the one the sign-in landed', r.storedToken === SECOND_ACCESS, String(r.storedToken))
  check('the stored account beside it is the one that signed in, with no /accounts opened', r.storedEmail === SECOND_EMAIL, String(r.storedEmail))
  const statusRow = end.split('\n').find(l => /^\s*│?\s*Anthropic\s/.test(l))
  if (statusRow === undefined) {
    record('/status', `the account rows are folded at ${COLS}x${ROWS}; the Anthropic row is not on this frame`)
    check('/status never names the account stored before the switch', end.includes('Mercury — status') && !end.includes(FIRST_EMAIL), tail(end, 20))
  } else {
    check('/status names the account that just signed in, with no /accounts opened', statusRow.includes(SECOND_EMAIL) && !statusRow.includes(FIRST_EMAIL), statusRow.trim())
  }
  if (failures > 0 || KEEP) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

if (LEG === 'face' || LEG === 'both') {
  if (!FULL_LAYOUT) {
    record('the face road', `needs the full layout (100x26 and up); skipped at ${COLS}x${ROWS}`)
  } else {
    section('the face road: the Logins layer, the loopback sign-in lands the second account, the pane, the roster, the chip')
    const r = await runLeg('face')
    const rosterBefore = markText(r.payload, 'roster-before')
    const pane = markText(r.payload, 'pane')
    const roster = markText(r.payload, 'roster')
    const end = r.payload === null ? '' : gridText(r.payload.grid)
    const claudeRow = (text: string): string | undefined =>
      text.split('\n').find(l => l.includes('Claude subscription account') && l.indexOf('Claude subscription account') < 60)
    record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} · ${r.daemon}`)
    record('fixture hits', r.hits.join(' | ') || 'none')
    record('the roster row before the sign-in', JSON.stringify(claudeRow(rosterBefore)?.trim() ?? null))
    record('the pane line', JSON.stringify(pane.split('\n').find(l => l.includes('Signed in')) ?? null))
    record('the roster row after ↵ done', JSON.stringify(claudeRow(roster)?.trim() ?? null))
    check('the Logins layer opened on the stored sign-in', (claudeRow(rosterBefore) ?? '').includes(FIRST_EMAIL), tail(rosterBefore, 16) || r.stderr.slice(-600))
    check('the loopback callback completed the flow and the profile was read with the minted token', r.hits.some(h => h.startsWith('POST /v1/oauth/token')) && r.hits.some(h => h.startsWith('GET /api/oauth/profile') && h.includes(`bearer=${SECOND_ACCESS}`)), r.hits.join(' | '))
    check('the success pane names the account that just signed in', pane.includes(`Signed in as ${SECOND_EMAIL}`), tail(pane, 14))
    check('the roster row behind the open pane already names the account that signed in', (claudeRow(pane) ?? '').includes(SECOND_EMAIL), claudeRow(pane)?.trim() ?? 'no row')
    check('↵ done leaves the roster naming the account that signed in', (claudeRow(roster) ?? '').includes(SECOND_EMAIL) && !(claudeRow(roster) ?? '').includes(FIRST_EMAIL), claudeRow(roster)?.trim() ?? 'no row')
    const chipLine = end.split('\n').find(l => l.includes('Acct'))
    if (chipLine === undefined) {
      record('the face chip', `the chip strip is shed at ${COLS}x${ROWS}; the face carries no account chip on this frame`)
    } else {
      check('the face chip names the account that signed in once the layer closes', chipLine.includes(SECOND_EMAIL) && !chipLine.includes(FIRST_EMAIL), chipLine.trim())
    }
    check('the stored account on file is the one that signed in', r.storedEmail === SECOND_EMAIL, String(r.storedEmail))
    if (failures > 0 || KEEP) kept.push(r.home)
    else rmSync(r.home, { recursive: true, force: true })
  }
}

for (const home of kept) console.log(`[forensics] world kept: ${home}`)
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
