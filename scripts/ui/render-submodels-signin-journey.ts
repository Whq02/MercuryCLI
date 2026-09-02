#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-submodels-signin-journey.ts — the operator's
//  repro, driven END TO END on the built dist: ONE session opens /submodels
//  signed out (the strict gate proves the honest why-not painted — and that
//  open is exactly what primes the discovery record the bug froze), signs in
//  the OpenAI leg through /logins (the device-code flow against a loopback
//  fixture), then opens /submodels AGAIN in the SAME session — the GPT rows
//  must now list under the credentialed family header. Before the fix the
//  second open still answered "not signed in": the openai adapter read the
//  boot-time discovery record instead of self-priming per read.
//
//  Hermetic: only the OpenAI AUTH + ChatGPT bases point at the loopback
//  fixture (device usercode/token, the /oauth/token exchange, and the live
//  /models catalogue); every other base is dead-pinned; BROWSER=true; a
//  virgin scratch home seeded past first-run; the file credential plane.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-submodels-signin-journey.ts
//        (needs dist/mercury.mjs — the gate prebuilds it)
//  Keep: SUBMODELS_CAPTURE_DIR=<dir> writes the final frame per width.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '../..')
const DIST = join(ROOT, 'dist/mercury.mjs')
const VSHOT = join(ROOT, 'scripts/ui/vshot.py')
const DEAD = 'http://127.0.0.1:9'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.error('render-submodels-signin-journey: dist/mercury.mjs missing — run the build first')
  process.exit(1)
}

// ── the loopback fixture (the openaiAccounts device + exchange + catalogue
//    wire shapes, verbatim) ──────────────────────────────────────────────────
const ACCESS = 'openai-access-fixture-0000000001'
const REFRESH = 'openai-refresh-fixture-000000001'
const b64url = (s: string): string => Buffer.from(s).toString('base64url')
// The id_token's ONLY consumed content is the claim nest
// `https://api.openai.com/auth` {chatgpt_account_id, chatgpt_plan_type}.
const ID_TOKEN = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture', chatgpt_plan_type: 'plus' },
  }),
)}.fixture`

type Hit = { method: string; path: string; bearer: string | undefined; body: string }
const hits: Hit[] = []
let deviceStarts = 0
let tokenPolls = 0
let pollsSinceStart = 0
let codeExchanges = 0
let refreshGrants = 0
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const body = Buffer.concat(chunks).toString('utf8')
    const auth = req.headers['authorization']
    const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined
    hits.push({ method: req.method ?? '', path, bearer, body })
    if (req.method === 'POST' && path === '/openai/deviceauth/usercode') {
      deviceStarts++
      pollsSinceStart = 0
      json(res, 200, { user_code: 'MERC-FIXT', device_auth_id: 'device-auth-1', interval: 1 })
      return
    }
    if (req.method === 'POST' && path === '/openai/deviceauth/token') {
      tokenPolls++
      pollsSinceStart++
      // pending on each drive's first poll (status-coded on this wire),
      // authorized on the next — the waiting screen provably paints before
      // the settle.
      if (pollsSinceStart === 1) {
        json(res, 404, {})
        return
      }
      json(res, 200, { authorization_code: 'fixture-auth-code', code_verifier: 'fixture-verifier' })
      return
    }
    if (req.method === 'POST' && path === '/openai/oauth/token') {
      // The endpoint serves BOTH grants: the device leg's code exchange and
      // the background refresh the catalogue read may kick (the fixture
      // access token states no exp claim, so a refresh is legitimate).
      const grant = new URLSearchParams(body).get('grant_type')
      if (grant === 'authorization_code') codeExchanges++
      if (grant === 'refresh_token') refreshGrants++
      json(res, 200, { id_token: ID_TOKEN, access_token: ACCESS, refresh_token: REFRESH })
      return
    }
    if (req.method === 'GET' && path === '/openai/models') {
      if (bearer !== ACCESS) return json(res, 401, { error: 'unauthorized' })
      json(res, 200, {
        data: [
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], context_window: 272000 },
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'] },
        ],
      })
      return
    }
    json(res, 404, {})
  })
})
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
const base = `http://127.0.0.1:${port}`

type Send = {
  data: string
  awaitText?: string
  awaitSettleTicks?: number
  afterPrevTicks?: number
  requireAwait?: boolean
}

console.log('============================================================')
console.log(' /submodels across the OpenAI sign-in, one live session')
console.log('============================================================')

async function drive(cols: number, rows: number): Promise<string> {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'submodels-journey-'))
  const cwd = join(home, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const configHome = join(home, 'confighome')
  seedFirstRun(configHome, [cwd])
  const out = join(home, 'grid.json')
  const cfgPath = join(home, 'cfg.json')
  const sends: Send[] = [
    // The composer up — the seeded home boots straight to the REPL.
    { requireAwait: true, awaitText: '? for shortcuts', awaitSettleTicks: 4, data: '/submodels\r' },
    // /submodels BEFORE the sign-in: the strict gate proves the honest
    // signed-out paint — and this open primes the discovery record whose
    // staleness WAS the bug. Then close it.
    { requireAwait: true, awaitText: 'sign in — /logins', awaitSettleTicks: 3, data: '\u001b' },
    // /logins with the OpenAI row pre-focused; ↵ enters the subscription
    // leg (browser PKCE first), d switches it to the device-code flow.
    { afterPrevTicks: 4, data: '/logins openai\r' },
    { requireAwait: true, awaitText: 'OpenAI', awaitSettleTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: 'browser', awaitSettleTicks: 3, data: 'd' },
    // The device wait paints the one-time code, the fixture walks
    // pending → authorized, the exchange lands, the receipt names the plan.
    { requireAwait: true, awaitText: 'MERC-FIXT', awaitSettleTicks: 1, data: ' ' },
    // The SAME session, /submodels again — the GPT rows must now list under
    // the credentialed family header (the repro's failing step).
    { requireAwait: true, awaitText: 'OpenAI connected', awaitSettleTicks: 3, data: '/submodels\r' },
  ]
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', DIST],
      cwd,
      sends,
      readyText: ['ChatGPT plus subscription'],
      readySettleTicks: 4,
      stableTicks: 4,
      total: 400,
      cols,
      rows,
      out,
    }),
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: configHome,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    ANTHROPIC_BASE_URL: DEAD,
    // Only the OpenAI AUTH + subscription bases ride the fixture; the
    // api-key lane stays dead (this journey is the ChatGPT leg).
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai`,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
  }
  for (const key of [
    'NODE_ENV', 'IS_DEMO',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR',
    'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
    'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
  ]) {
    delete env[key]
  }

  // Async spawn: the loopback fixture lives in THIS process — a synchronous
  // spawn would freeze the event loop and the child's OAuth POSTs would hang
  // unanswered forever (the kimi-leg rig's observed wedge class).
  const run = await new Promise<{ code: number | null; output: string }>(resolveRun => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), 160000)
    child.on('close', code => {
      clearTimeout(killer)
      resolveRun({ code, output })
    })
  })
  let grid = ''
  try {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    grid = payload.grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
  } catch {
    /* no grid written — the boot itself died */
  }
  if (run.code !== 0) {
    check(`the ${cols}-col drive completed`, false, run.output.split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300))
    if (grid !== '') console.error('── the stalled frame ──\n' + grid.split('\n').slice(0, 30).join('\n'))
  } else {
    check(`the ${cols}-col drive completed`, true)
    const keep = process.env.SUBMODELS_CAPTURE_DIR
    if (keep) {
      mkdirSync(keep, { recursive: true })
      writeFileSync(join(keep, `submodels-signin-journey-${cols}.txt`), grid)
    }
  }
  rmSync(home, { recursive: true, force: true })
  return grid
}

let grids: Record<number, string> = {}
try {
  grids[100] = await drive(100, 40)
  grids[120] = await drive(120, 44)
} finally {
  server.close()
}

for (const cols of [100, 120]) {
  const grid = grids[cols] ?? ''
  const lines = grid.split('\n')
  const openaiHeader = lines.find(line => line.includes('OpenAI') && !line.includes('models')) ?? ''
  check(
    `${cols} cols: the OpenAI family header wears the subscription label`,
    openaiHeader.includes('ChatGPT plus subscription') && !openaiHeader.includes('not signed in'),
    openaiHeader.trim().slice(0, 120),
  )
  const solLine = lines.find(line => line.includes('GPT-5.6 Sol')) ?? ''
  check(
    `${cols} cols: the live GPT row lists WITHOUT a sign-in route`,
    solLine !== '' && !solLine.includes('sign in — /logins'),
    solLine.trim().slice(0, 120),
  )
  check(`${cols} cols: no secret painted on the final frame`, !grid.includes(ACCESS) && !grid.includes(REFRESH))
}
// The wire story, from the fixture's own log:
check('the fixture saw ONE device-authorization start per drive (2 total)', deviceStarts === 2, `starts=${deviceStarts}`)
check('the device grant polled pending → authorized in each drive', tokenPolls >= 4, `polls=${tokenPolls}`)
check('ONE code exchange landed on the pinned issuer per drive', codeExchanges === 2, `code=${codeExchanges} refresh=${refreshGrants}`)
check(
  'the live catalogue was fetched under the fresh bearer',
  hits.some(hit => hit.path === '/openai/models' && hit.bearer === ACCESS),
  JSON.stringify([...new Set(hits.map(hit => hit.path))]),
)
check('no request ever carried the refresh token as a bearer', !hits.some(hit => hit.bearer === REFRESH))

console.log(failures === 0 ? '\nSUBMODELS SIGN-IN JOURNEY: ALL GREEN' : `\nSUBMODELS SIGN-IN JOURNEY: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
