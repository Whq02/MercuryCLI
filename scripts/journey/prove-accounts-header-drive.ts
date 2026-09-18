#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? path.join(REPO, 'dist/mercury.mjs')
const FRAMES = argAfter('--frames')
const LABEL = argAfter('--label') ?? 'board'
const SIZE = argAfter('--size') ?? '120x40'
const KEEP = process.argv.includes('--keep')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const ANTHROPIC_EMAIL = 'claude-operator@fixture.example'
const OPENAI_EMAIL = 'gpt-operator@fixture.example'
const DEAD = 'http://127.0.0.1:9'

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
type Payload = { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
const tail = (text: string, lines: number): string => text.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')

function startProfileFixture(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET' && (req.url ?? '').startsWith('/api/oauth/profile')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ account: { uuid: 'uuid-live-fixture', email_address: ANTHROPIC_EMAIL, full_name: 'Fixture Operator' }, organization: { uuid: 'org-fixture', name: 'Fixture Org' } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ port, hits, close: () => server.close() })
    })
  })
}

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
      oauthAccount: { accountUuid: 'uuid-fixture', emailAddress: ANTHROPIC_EMAIL, organizationUuid: 'org-fixture', organizationName: 'Fixture Org' },
    }),
  )
  writeFileSync(path.join(runHome, 'settings.json'), '{}')
  writeFileSync(
    path.join(runHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: 'fixture-refresh-token-00000000001',
        expiresAt: 4102444800000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: null,
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    path.join(runHome, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: OPENAI_EMAIL },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    path.join(runHome, '.sign-ins.json'),
    JSON.stringify({ version: 1, signIns: { anthropic: { at: Date.now() - 60_000, kind: 'oauth' }, openai: { at: Date.now() - 30_000, kind: 'subscription' } } }),
    { mode: 0o600 },
  )
  writeFileSync(path.join(fixtureCwd, 'README.md'), '# accounts header drive fixture\n')
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
  const record = path.join(runHome, 'daemon', 'supervisor.json')
  if (!existsSync(record)) return 'no daemon record'
  let pid = 0
  try {
    pid = Number((JSON.parse(readFileSync(record, 'utf8')) as { pid?: number }).pid ?? 0)
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

async function runBoard(): Promise<{ payload: Payload | null; status: number | null; home: string; hits: string[]; stderr: string; daemon: string }> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-accounts-header-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  seedHome(RUN_HOME, FIXTURE_CWD)
  const fixture = await startProfileFixture()
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: [NODE, DIST, '--model', 'claude-opus-4-8'],
    cwd: FIXTURE_CWD,
    sends: [
      { atTick: 70, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'face' },
      { atTick: 150, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: '/accounts', mark: 'composer' },
      { afterPrevTicks: 4, data: '\r' },
    ],
    readyText: ['Anthropic accounts'],
    readySettleTicks: 4,
    stableTicks: 8,
    total: 300,
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
    BROWSER: '/usr/bin/true',
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
    }, vshotBudgetMs(150_000))
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
    for (const mark of payload.marks ?? []) writeFileSync(path.join(FRAMES, `${LABEL}-${mark.label}-${COLS}x${ROWS}.txt`), gridText(mark.grid))
    writeFileSync(path.join(FRAMES, `${LABEL}-${COLS}x${ROWS}.txt`), gridText(payload.grid))
  }
  return { payload, status, home: RUN_HOME, hits: fixture.hits, stderr: `${captureStderr}${leftovers.length > 0 ? `\nleftover pids ended: ${leftovers.join(',')}` : ''}`, daemon }
}

console.log('============================================================')
console.log(' the /accounts board headers carry no count — the real binary, one Anthropic and one OpenAI sign-in on file')
console.log(`   dist: ${DIST}`)
console.log(`   size: ${COLS}x${ROWS}`)
console.log('============================================================')

section('the board, with the Anthropic scope verified live over the loopback profile fixture')
const r = await runBoard()
const text = r.payload === null ? '' : gridText(r.payload.grid)
const lines = text.split('\n')
const anthropicLine = lines.find(l => l.includes('Anthropic accounts'))
const openaiLine = lines.find(l => l.includes('OpenAI accounts'))
const countWords = (line: string | undefined): boolean => line !== undefined && (/\d\s*\/\s*\d/.test(line) || line.includes('signed in') || /accounts\s*\(\d+\)/.test(line))
record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} · ${r.daemon}`)
record('the Anthropic header row', JSON.stringify(anthropicLine?.trim() ?? null))
record('the OpenAI header row', JSON.stringify(openaiLine?.trim() ?? null))
check('the board opened with the Anthropic family header', anthropicLine !== undefined, tail(text, 16) || r.stderr.slice(-800))
check('the live identity probe reached the fixture profile endpoint (the scope sign-in is verified, not a snapshot)', r.hits.some(h => h.includes('/api/oauth/profile')), r.hits.join(' | ') || 'no request reached the fixture')
check('the Anthropic row below the header names the sign-in', text.includes('claude') && (text.includes(ANTHROPIC_EMAIL) || text.includes(ANTHROPIC_EMAIL.slice(0, 12))), tail(text, 16))
check('the Anthropic header reads "Anthropic accounts" with no "x/y", no "signed in" and no count chip', anthropicLine !== undefined && !countWords(anthropicLine), anthropicLine?.trim())
if (openaiLine === undefined) {
  record('the OpenAI family', `below the fold at ${COLS}x${ROWS}; its header is not on this frame`)
} else {
  check('the OpenAI row below the header names the sign-in', text.includes('chatgpt') || text.includes(OPENAI_EMAIL) || text.includes('subscription'), tail(text, 16))
  check('the OpenAI header reads "OpenAI accounts" with no "x/y", no "signed in" and no count chip', !countWords(openaiLine), openaiLine.trim())
}

if (failures > 0 || KEEP) console.log(`[forensics] world kept: ${r.home}`)
else rmSync(r.home, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
