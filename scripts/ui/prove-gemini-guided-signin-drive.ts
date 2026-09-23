#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createProbeServer } from 'node:net'
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
const LABEL = argAfter('--label') ?? 'gemini-guided'
const SIZE = argAfter('--size') ?? '120x40'
const LEG = argAfter('--leg') ?? 'all'
const WORLD_ROOT = argAfter('--world') ?? realpathSync(tmpdir())
const KEEP = process.argv.includes('--keep')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const DEAD = 'http://127.0.0.1:9'
const FIXTURE_KEY = 'AIzaFixtureGuidedSignin0123456789abcdefghij'
const FIXTURE_CLIENT = 'fixture-client-id.apps.googleusercontent.com'
const FIXTURE_ACCESS = 'fixture-google-access-token-0001'
const FIXTURE_REFRESH = 'fixture-google-refresh-token-0001'
const LOOPBACK_PORT = 1457
const CALLBACK = `http://127.0.0.1:${LOOPBACK_PORT}/oauth2/callback`
const PASTED_CODE = `${CALLBACK}?code=fixture-authorization-code`
const PASTED_REFUSAL = `${CALLBACK}?error=access_denied&error_description=fixture+refusal`
const AI_STUDIO = 'https://aistudio.google.com/apikey'
const STEP_PAGES = [
  'https://console.cloud.google.com/projectcreate',
  'https://console.cloud.google.com/flows/enableapi?apiid=generativelanguage.googleapis.com',
  'https://console.developers.google.com/auth/audience',
  'https://console.developers.google.com/auth/clients',
]

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
const loopbackFree = await new Promise<boolean>(resolve => {
  const probe = createProbeServer()
  probe.once('error', () => resolve(false))
  probe.listen(LOOPBACK_PORT, '127.0.0.1', () => probe.close(() => resolve(true)))
})
if (!loopbackFree) {
  console.log(`SKIP the Google sign-in's loopback port ${LOOPBACK_PORT} is held by another process on this box; the drive cannot complete a sign-in here`)
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
const flat = (text: string): string =>
  text
    .split('\n')
    .map(l => l.replace(/[│╭╮╰╯─]/g, ' ').trim())
    .filter(l => l !== '')
    .join(' ')
    .replace(/\s+/g, ' ')

function startFixture(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    const key = String(req.headers['x-goog-api-key'] ?? '')
    hits.push(`${req.method ?? ''} ${url}${bearer ? ` bearer=${bearer}` : ''}${key ? ` key=${key}` : ''}`)
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'POST' && url.startsWith('/token')) {
        json(200, {
          access_token: FIXTURE_ACCESS,
          refresh_token: FIXTURE_REFRESH,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever',
        })
        return
      }
      if (req.method === 'GET' && url.startsWith('/v1beta/models')) {
        json(200, {
          models: [
            {
              name: 'models/gemini-fixture-pro',
              displayName: 'Gemini Fixture Pro',
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
            },
          ],
        })
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

function seedHome(runHome: string, fixtureCwd: string, opts: { storedClient: boolean }): { browser: string; opens: string } {
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
      customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(runHome, 'settings.json'), '{}')
  if (opts.storedClient) {
    writeFileSync(path.join(runHome, '.gemini-auth.json'), JSON.stringify({ version: 1, client: { clientId: FIXTURE_CLIENT } }), { mode: 0o600 })
  }
  writeFileSync(path.join(fixtureCwd, 'README.md'), '# guided sign-in drive fixture\n')
  const opens = path.join(runHome, 'browser-opens.log')
  const browser = path.join(runHome, 'fixture-browser.sh')
  writeFileSync(browser, ['#!/bin/bash', `printf '%s\\n' "$1" >> "${opens}"`, 'exit 0', ''].join('\n'))
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
const gate = (awaitText: string, data: string, mark?: string, settle = 4): Send => ({ requireAwait: true, awaitText, awaitSettleTicks: settle, data, ...(mark ? { mark } : {}) })
const after = (ticks: number, data: string, mark?: string): Send => ({ afterPrevTicks: ticks, data, ...(mark ? { mark } : {}) })

function openCard(): Send[] {
  return [
    { atTick: 90, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'face' },
    { minTick: 10, ...composerGate, data: '/logins gemini', mark: 'composer' },
    after(4, '\r'),
    gate('Google Gemini —', '\r', 'menu', 3),
  ]
}

function reopenCard(): Send[] {
  return [after(4, '/logins gemini'), after(4, '\r'), gate('Google Gemini —', '\r', undefined, 3)]
}

function statusEnd(): Send[] {
  return [after(2, '/status'), after(4, '\r')]
}

function walkSends(): Send[] {
  return [
    ...openCard(),
    gate('Connect Google Gemini', '\r', 'card'),
    gate('Create API key', FIXTURE_KEY, 'key-leg'),
    after(4, '\r'),
    gate('Gemini API key stored', '', 'key-receipt'),
    ...reopenCard(),
    gate('connected (stored locally)', '\x1b[B', 'card-connected'),
    after(3, '\r'),
    gate('step 1 of 6', '\r', 'step1'),
    gate('step 2 of 6', '\r', 'step2'),
    gate('step 3 of 6', '\r', 'step3'),
    gate('step 4 of 6', '\r', 'step4'),
    gate('step 5 of 6', FIXTURE_CLIENT, 'step5'),
    after(4, '\r'),
    gate('Client secret', '\r', 'step5-secret', 3),
    gate('step 6 of 6', '', 'step6'),
    after(2, PASTED_CODE),
    after(3, '\r'),
    gate('Gemini connected: Google account', '', 'oauth-receipt'),
    ...reopenCard(),
    gate('Google account — connected', '\x1b[B', 'card-after'),
    after(3, '\r'),
    gate('step 6 of 6', '', 'step6-direct'),
    after(2, PASTED_CODE),
    after(3, '\r'),
    gate('Gemini connected: Google account', '', 'end-receipt', 6),
    ...statusEnd(),
  ]
}

function deniedSends(): Send[] {
  return [
    ...openCard(),
    gate('the client id is stored', '\x1b[B', 'card-stored'),
    after(3, '\r'),
    gate('step 6 of 6', '', 'denied-step6-first'),
    after(2, PASTED_REFUSAL),
    after(3, '\r'),
    gate('step 3 of 6', '\r', 'denied-step3', 6),
    gate('step 4 of 6', '\r', 'denied-step4'),
    gate('step 5 of 6', '\r', 'denied-step5'),
    gate('Client secret', '\r', undefined, 3),
    gate('step 6 of 6', '', 'denied-step6'),
    after(2, PASTED_CODE),
    after(3, '\r'),
    gate('Gemini connected: Google account', '', 'denied-receipt'),
    ...statusEnd(),
  ]
}

function lookSends(): Send[] {
  return [...openCard(), gate('Connect Google Gemini', '\x1b[B', 'card'), after(3, '\r'), after(15, '', 'second'), after(2, '\x1b'), after(4, '\x1b'), after(4, '\x1b'), ...statusEnd()]
}

async function runLeg(leg: 'walk' | 'denied' | 'look'): Promise<{
  payload: Payload | null
  status: number | null
  home: string
  hits: string[]
  opens: string[]
  stderr: string
  daemon: string
  auth: { clientId?: string; refreshToken?: string }
  keyStored: boolean
}> {
  const RUN_HOME = path.join(WORLD_ROOT, `mercury-gemini-guided-${leg}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const seeded = seedHome(RUN_HOME, FIXTURE_CWD, { storedClient: leg === 'denied' })
  const fixture = await startFixture()
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: [NODE, DIST, '--model', 'claude-opus-5'],
    cwd: FIXTURE_CWD,
    sends: leg === 'walk' ? walkSends() : leg === 'denied' ? deniedSends() : lookSends(),
    readyText: ['Mercury — status'],
    readySettleTicks: 6,
    stableTicks: 8,
    total: leg === 'walk' ? 1500 : 900,
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
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: `http://127.0.0.1:${fixture.port}/v1beta`,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: `http://127.0.0.1:${fixture.port}/authorize`,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: `http://127.0.0.1:${fixture.port}/token`,
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
    BROWSER: seeded.browser,
  }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'MERCURY_GEMINI_OAUTH_CLIENT_ID',
    'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
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
    'NODE_ENV',
    'CI',
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
    }, vshotBudgetMs(leg === 'walk' ? 420_000 : 240_000))
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
  const auth: { clientId?: string; refreshToken?: string } = {}
  try {
    const file = JSON.parse(readFileSync(path.join(RUN_HOME, '.gemini-auth.json'), 'utf8')) as { client?: { clientId?: string }; tokens?: { refreshToken?: string } }
    if (file.client?.clientId) auth.clientId = file.client.clientId
    if (file.tokens?.refreshToken) auth.refreshToken = file.tokens.refreshToken
  } catch {
  }
  let keyStored = false
  try {
    keyStored = readFileSync(path.join(RUN_HOME, '.provider-secrets.json'), 'utf8').includes(FIXTURE_KEY)
  } catch {
  }
  let opens: string[] = []
  try {
    opens = readFileSync(seeded.opens, 'utf8').split('\n').filter(l => l.trim() !== '')
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
    auth,
    keyStored,
  }
}

console.log('============================================================')
console.log(' the Gemini connect card walks a person to a working sign-in: the API key first, the Google account as six steps')
console.log(`   dist: ${DIST}`)
console.log(`   size: ${COLS}x${ROWS} · leg: ${LEG}`)
console.log('============================================================')

const kept: string[] = []
const isAuthorize = (url: string): boolean => url.includes('/authorize?') && url.includes('state=')

if (LEG === 'walk' || LEG === 'all') {
  section('the walk: the key road, the connected row, the six steps, the stored client id opening at step 6')
  const r = await runLeg('walk')
  const card = flat(markText(r.payload, 'card'))
  const keyLeg = flat(markText(r.payload, 'key-leg'))
  const keyReceipt = flat(markText(r.payload, 'key-receipt'))
  const cardConnected = flat(markText(r.payload, 'card-connected'))
  const step1 = flat(markText(r.payload, 'step1'))
  const step3 = flat(markText(r.payload, 'step3'))
  const step5 = flat(markText(r.payload, 'step5'))
  const step6 = flat(markText(r.payload, 'step6'))
  const oauthReceipt = flat(markText(r.payload, 'oauth-receipt'))
  const cardAfter = flat(markText(r.payload, 'card-after'))
  const step6Direct = flat(markText(r.payload, 'step6-direct'))
  const endReceipt = flat(markText(r.payload, 'end-receipt'))
  record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} marks=${(r.payload?.marks ?? []).map(m => m.label).join(',')} · ${r.daemon}`)
  record('fixture hits', r.hits.join(' | ') || 'none')
  record('browser opens', r.opens.map(u => (isAuthorize(u) ? 'authorize(state)' : u)).join(' | ') || 'none')
  check('the card offers the API key first, with the ruled words, and the Google account second', card.includes('1. API key — the easiest: create one in AI Studio, paste it here') && card.includes('2. Google account — six steps, each opens its Console page'), tail(markText(r.payload, 'card'), 16) || r.stderr.slice(-600))
  check('the key row opened AI Studio in the browser before the paste', r.opens[0] === AI_STUDIO && keyLeg.includes('AI Studio opened in your browser') && keyLeg.includes(AI_STUDIO), `${r.opens[0] ?? 'no open'} · ${tail(markText(r.payload, 'key-leg'), 8)}`)
  check('the pasted key was stored and proved on the live catalogue with the key itself', r.keyStored && r.hits.some(h => h.startsWith('GET /v1beta/models') && h.includes(`key=${FIXTURE_KEY}`)) && keyReceipt.includes('Gemini API key stored'), r.hits.join(' | '))
  check('the reopened card shows the key row as connected', cardConnected.includes('API key — connected (stored locally)'), tail(markText(r.payload, 'card-connected'), 12))
  check('step 1 opened the project page and names it', step1.includes('step 1 of 6') && step1.includes(STEP_PAGES[0]!) && r.opens.includes(STEP_PAGES[0]!), tail(markText(r.payload, 'step1'), 12))
  check('step 3 marks itself current, names External and the test users, and opened the Audience page', step3.includes('› 3. Set up the consent screen for testing') && step3.includes('Test users') && step3.includes('the overview page:') && r.opens.includes(STEP_PAGES[2]!), tail(markText(r.payload, 'step3'), 14))
  const consoleOpens = r.opens.filter(u => STEP_PAGES.includes(u))
  check('the four Console pages opened once each, in step order', consoleOpens.join('|') === STEP_PAGES.join('|'), consoleOpens.join(' | '))
  check('step 5 took the client id by paste and the store kept it', step5.includes('step 5 of 6') && step5.includes('Client id:') && r.auth.clientId === FIXTURE_CLIENT, `${r.auth.clientId ?? 'no client'} · ${tail(markText(r.payload, 'step5'), 10)}`)
  check('step 6 opened the browser sign-in and printed the fallback address', step6.includes('step 6 of 6') && step6.includes('If nothing opened, visit:') && r.opens.some(isAuthorize), tail(markText(r.payload, 'step6'), 12))
  check('the pasted redirect completed the exchange and the Google account was proved on the live catalogue', r.hits.some(h => h.startsWith('POST /token')) && r.hits.some(h => h.startsWith('GET /v1beta/models') && h.includes(`bearer=${FIXTURE_ACCESS}`)) && r.auth.refreshToken === FIXTURE_REFRESH, r.hits.join(' | '))
  check('the chat receipt names the connected Google account', oauthReceipt.includes('Gemini connected: Google account (OAuth)'), tail(markText(r.payload, 'oauth-receipt'), 10))
  check('the reopened card shows the Google account as connected and signing in again from step 6', cardAfter.includes('Google account — connected · ↵ signs in again (step 6)'), tail(markText(r.payload, 'card-after'), 12))
  const firstAuthorize = r.opens.findIndex(isAuthorize)
  const afterFirst = r.opens.slice(firstAuthorize + 1)
  check('with the client id stored the card opened at step 6 and no Console page opened again', step6Direct.includes('step 6 of 6') && afterFirst.length > 0 && afterFirst.every(isAuthorize), afterFirst.join(' | ') || 'no second open')
  const lastToken = r.hits.map((h, i) => (h.startsWith('POST /token') ? i : -1)).filter(i => i >= 0).pop() ?? -1
  check('the second sign-in exchanged again, proved the catalogue again and landed its receipt without asking for anything twice', r.hits.filter(h => h.startsWith('POST /token')).length === 2 && r.hits.slice(lastToken + 1).some(h => h.startsWith('GET /v1beta/models') && h.includes(`bearer=${FIXTURE_ACCESS}`)) && endReceipt.includes('Gemini connected: Google account'), `${r.hits.join(' | ')} · ${tail(markText(r.payload, 'end-receipt'), 6)}`)
  if (failures > 0 || KEEP) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

if (LEG === 'denied' || LEG === 'all') {
  section('the refusal: access_denied returns the card to step 3 with its page opened; the walk on from there signs in')
  const r = await runLeg('denied')
  const cardStored = flat(markText(r.payload, 'card-stored'))
  const step6First = flat(markText(r.payload, 'denied-step6-first'))
  const step3 = flat(markText(r.payload, 'denied-step3'))
  const step5 = flat(markText(r.payload, 'denied-step5'))
  const receipt = flat(markText(r.payload, 'denied-receipt'))
  record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} marks=${(r.payload?.marks ?? []).map(m => m.label).join(',')} · ${r.daemon}`)
  record('fixture hits', r.hits.join(' | ') || 'none')
  record('browser opens', r.opens.map(u => (isAuthorize(u) ? 'authorize(state)' : u)).join(' | ') || 'none')
  check('a stored client id reads on the row and the account road starts at step 6', cardStored.includes('Google account — the client id is stored · ↵ signs in (step 6)') && step6First.includes('step 6 of 6') && r.opens.length > 0 && isAuthorize(r.opens[0]!), `${r.opens[0] ?? 'no open'} · ${tail(markText(r.payload, 'card-stored'), 12)}`)
  check("Google's access_denied, pasted as the redirected URL, returned the card to step 3 with today's refusal words under the page", step3.includes('step 3 of 6') && step3.includes('access_denied') && step3.includes('not one of its test users') && step3.includes('add your account under Test users'), tail(markText(r.payload, 'denied-step3'), 16) || r.stderr.slice(-600))
  check('the Audience page opened again for the return to step 3', r.opens[1] === STEP_PAGES[2], r.opens.join(' | '))
  check('step 5 started from the stored client id', step5.includes(FIXTURE_CLIENT), tail(markText(r.payload, 'denied-step5'), 10))
  check('the walk on from step 3 signed in: the exchange, the catalogue, the receipt', r.hits.some(h => h.startsWith('POST /token')) && r.auth.refreshToken === FIXTURE_REFRESH && receipt.includes('Gemini connected: Google account (OAuth)'), r.hits.join(' | '))
  if (failures > 0 || KEEP) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

if (LEG === 'look') {
  section('a look at the card and its second screen (frames only; no verdict)')
  const r = await runLeg('look')
  record('capture', `vshot=${r.status} end=${r.payload?.endReason ?? '?'} marks=${(r.payload?.marks ?? []).map(m => m.label).join(',')} · ${r.daemon}`)
  record('browser opens', r.opens.map(u => (isAuthorize(u) ? 'authorize(state)' : u)).join(' | ') || 'none')
  record('the card', tail(markText(r.payload, 'card'), 14))
  record('the second screen', tail(markText(r.payload, 'second'), 16))
  if (KEEP) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

for (const home of kept) console.log(`[forensics] world kept: ${home}`)
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
