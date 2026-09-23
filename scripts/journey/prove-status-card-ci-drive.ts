#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const LABEL = argAfter('--label') ?? 'status-card'
const SIZE = argAfter('--size') ?? '120x40'
const WORLD_ROOT = argAfter('--world') ?? realpathSync(tmpdir())
const KEEP = process.argv.includes('--keep')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const EMAIL = 'first@fixture.example'
const ORGANISATION = 'First Org'
const DEAD = 'http://127.0.0.1:9'
const FULL_LAYOUT = COLS >= 100 && ROWS >= 26
const CARD_TITLE = 'Mercury — status'
const REFUSAL = 'No credential found'
const KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR']

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

function seedHome(runHome: string, fixtureCwd: string): void {
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
        emailAddress: EMAIL,
        organizationUuid: 'org-first',
        organizationName: ORGANISATION,
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
        accessToken: 'fixture-first-access-token-0001',
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
  writeFileSync(path.join(fixtureCwd, 'README.md'), '# status card drive fixture\n')
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

function sends(fixtureCwd: string): Send[] {
  const born = FULL_LAYOUT ? '← back' : '1 session on'
  const down = (): Send => ({ afterPrevTicks: 2, data: '\x1b[B' })
  return [
    { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r', mark: 'face' },
    { requireAwait: true, awaitText: born, minTick: 10, awaitSettleTicks: 6, data: '/status', mark: 'composer' },
    { afterPrevTicks: 4, data: '\r' },
    ...(FULL_LAYOUT
      ? []
      : [{ requireAwait: true, awaitText: CARD_TITLE, minTick: 1, awaitSettleTicks: 4, data: '\x1b[B', mark: 'card' }, down(), down(), down(), down()]),
  ]
}

async function run(): Promise<{
  payload: Payload | null
  status: number | null
  home: string
  stderr: string
  daemon: string
  crashReports: string[]
  childKeys: string[]
}> {
  const RUN_HOME = path.join(WORLD_ROOT, `mercury-status-card-ci-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  seedHome(RUN_HOME, FIXTURE_CWD)
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: [NODE, DIST, '--model', 'claude-opus-5'],
    cwd: FIXTURE_CWD,
    sends: sends(FIXTURE_CWD),
    readyText: [CARD_TITLE],
    readySettleTicks: 6,
    stableTicks: 8,
    total: 400,
    cols: COLS,
    rows: ROWS,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'true',
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CUSTOM_OAUTH_URL: DEAD,
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
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    BROWSER: '/usr/bin/true',
  }
  for (const key of [
    ...KEY_VARIABLES,
    'NODE_ENV',
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
  const childKeys = KEY_VARIABLES.filter(key => childEnv[key] !== undefined)
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
    }, vshotBudgetMs(150_000))
    capture.on('exit', code => {
      clearTimeout(wall)
      resolve(code)
    })
  })
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
    for (const mark of payload.marks ?? []) writeFileSync(path.join(FRAMES, `${LABEL}-${mark.label}-${COLS}x${ROWS}.txt`), gridText(mark.grid))
    writeFileSync(path.join(FRAMES, `${LABEL}-status-${COLS}x${ROWS}.txt`), gridText(payload.grid))
  }
  const crashDir = path.join(RUN_HOME, 'crashes')
  const crashReports = existsSync(crashDir) ? readdirSync(crashDir) : []
  return {
    payload,
    status,
    home: RUN_HOME,
    stderr: `${captureStderr}${leftovers.length > 0 ? `\nleftover pids ended: ${leftovers.join(',')}` : ''}`,
    daemon,
    crashReports,
    childKeys,
  }
}

console.log('============================================================')
console.log(' the status card paints under CI with no key variable — the real binary, a stored claude.ai sign-in, CI=true, /status')
console.log(`   dist: ${DIST}`)
console.log(`   size: ${COLS}x${ROWS} (${FULL_LAYOUT ? 'full' : 'compact'} layout)`)
console.log('============================================================')

const r = await run()
const end = r.payload === null ? '' : gridText(r.payload.grid)
const statusRow = end.split('\n').find(l => /\bAnthropic\b/.test(l) && !l.includes('ANTHROPIC_'))
record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} · ${r.daemon}`)
record('the child environment', `CI=true · key variables present: ${r.childKeys.length === 0 ? 'none' : r.childKeys.join(',')}`)
record('the Anthropic row', JSON.stringify(statusRow?.trim() ?? null))
check('the product ran with CI set and no key variable in its environment', r.childKeys.length === 0, r.childKeys.join(','))
check('the status card paints and the capture ends on it, not on an exit', end.includes(CARD_TITLE) && r.payload?.endReason !== 'eof', tail(end, 16) || r.stderr.slice(-600))
check('no render error closes the view and no credential refusal reaches the screen', end !== '' && !/RENDER.ERROR/.test(end) && !end.includes(REFUSAL) && !end.includes('exited on an error'), tail(end, 16))
check('no crash report is written', r.crashReports.length === 0, r.crashReports.join(','))
if (statusRow === undefined) {
  record('/status', `the Anthropic row is not on this frame at ${COLS}x${ROWS}`)
  check('the card paints with its rows folded and no refusal on it', end.includes(CARD_TITLE) && !end.includes(REFUSAL), tail(end, 16))
} else {
  check('the Anthropic row paints the stored account', statusRow.includes(EMAIL), statusRow.trim())
  check('the row carries the organisation the stored account names, read through the account reader', statusRow.includes(ORGANISATION), statusRow.trim())
}
if (failures > 0 || KEEP) console.log(`[forensics] world kept: ${r.home}`)
else rmSync(r.home, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
