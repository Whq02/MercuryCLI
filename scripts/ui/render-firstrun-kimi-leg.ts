#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-firstrun-kimi-leg.ts — ONE family's sign-in leg driven
//  FROM THE FIRST-RUN WALK against a loopback fixture: the reuse is real,
//  not a lookalike. The Kimi (Moonshot) device-code flow is the established
//  pattern (prove-provider-logins §1 owns the driver end to end); here the
//  BUILT dist boots a virgin home, the walk's provider station offers the
//  catalogue, the Kimi row runs KimiConnect IN PLACE (choice → region →
//  device wait), the fixture walks pending → authorized, and the WALK
//  ADVANCES to Guardrails only on the settled ok — proving the station
//  settles a real engine-leg credential through the same component /logins
//  mounts.
//
//  Hermetic: only the Moonshot OAuth + coding bases point at the loopback
//  fixture; every other base is dead-pinned; BROWSER=true (the device leg
//  opens a verification page); virgin scratch home, the extensions estate
//  policy-blocked. Station transitions are strict-gated sends.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  console.error('render-firstrun-kimi-leg: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

// ── the loopback fixture (the prove-provider-logins §1 shapes) ──────────────
const KIMI_ACCESS = 'kimi-access-fixture-000000000001'
const KIMI_REFRESH = 'kimi-refresh-fixture-00000000001'
type Hit = { path: string; bearer: string | undefined; body: string }
const hits: Hit[] = []
let deviceStarts = 0
let tokenPolls = 0
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
    hits.push({ path, bearer, body })
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/device_authorization') {
      deviceStarts++
      json(res, 200, {
        device_code: 'kimi-device-code-1',
        user_code: 'KIMI-FIXT',
        verification_uri: `${base}/kimi/activate`,
        verification_uri_complete: `${base}/kimi/activate?user_code=KIMI-FIXT`,
        expires_in: 300,
        interval: 1,
      })
      return
    }
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/token') {
      tokenPolls++
      // pending on the first poll, authorized on the next — the waiting
      // screen provably paints before the settle.
      if (tokenPolls === 1) {
        json(res, 400, { error: 'authorization_pending' })
        return
      }
      json(res, 200, { access_token: KIMI_ACCESS, refresh_token: KIMI_REFRESH, expires_in: 3600, token_type: 'Bearer', scope: 'kimi-code' })
      return
    }
    if (req.method === 'GET' && path === '/kimi/coding/v1/usages') {
      if (bearer !== KIMI_ACCESS) return json(res, 401, { error: 'unauthorized' })
      json(res, 200, {
        usage: { used: '40', limit: '1000', resetTime: '2026-08-30T00:00:00Z' },
        limits: [
          { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '1', limit: '100', resetTime: '2026-08-23T12:00:00Z' } },
          { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: '40', limit: '1000', resetTime: '2026-08-30T00:00:00Z', name: 'weekly' } },
        ],
        boosterWallet: { balance: '0', monthlyChargeLimit: '0', monthlyUsed: '0', monthlyChargeLimitEnabled: false },
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
console.log(' the Kimi device-code leg, driven FROM the first-run walk')
console.log('============================================================')

const home = mkdtempSync(join(realpathSync(tmpdir()), 'firstrun-kimi-'))
const cwd = join(home, 'workspace')
mkdirSync(cwd, { recursive: true })
const configHome = join(home, 'confighome')
mkdirSync(configHome, { recursive: true })
const out = join(home, 'grid.json')
const cfgPath = join(home, 'cfg.json')
const sends: Send[] = [
  { requireAwait: true, awaitText: 'welcome — pick our colors', awaitSettleTicks: 4, data: '\r' },
  // Six ↓ from the catalogue's first row lands the Kimi row (7 of 9).
  { requireAwait: true, awaitText: 'Kimi (Moonshot) — device-code sign-in or API key', awaitSettleTicks: 3, data: '\x1b[B' },
  ...Array.from({ length: 5 }, (): Send => ({ afterPrevTicks: 2, data: '\x1b[B' })),
  { afterPrevTicks: 3, data: '\r' },
  // KimiConnect's OWN screens, in place: choice → region → device wait. The
  // space sends are inert keys whose strict gates PROVE each screen painted.
  { requireAwait: true, awaitText: 'A Kimi account signs in with a device code', awaitSettleTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'which deployment holds your account', awaitSettleTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'KIMI-FIXT', awaitSettleTicks: 1, data: ' ' },
]
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST], cwd, sends, readyText: ['Guardrails'], readySettleTicks: 4, stableTicks: 4, total: 250, cols: 100, rows: 40, out }))
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
  MERCURY_OPENAI_API_BASE: DEAD,
  MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENAI_AUTH_BASE: DEAD,
  MERCURY_OPENROUTER_API_BASE: DEAD,
  MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_GEMINI_API_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
  MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/kimi/oauth`,
  MERCURY_MOONSHOT_CODING_BASE: `${base}/kimi/coding/v1`,
  MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
  MERCURY_DEEPSEEK_API_BASE: DEAD,
}
for (const key of [
  'NODE_ENV', 'IS_DEMO',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
  'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
]) {
  delete env[key]
}

// The vshot run must be ASYNC: the loopback fixture lives in THIS process,
// so a synchronous spawn would freeze the event loop and the child's OAuth
// POSTs would hang unanswered forever (the drive stalls at 'Requesting a
// device code…' with zero fixture hits — observed before this spawn).
function runVshot(): Promise<{ code: number | null; output: string }> {
  return new Promise(resolveRun => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), 110000)
    child.on('close', code => {
      clearTimeout(killer)
      resolveRun({ code, output })
    })
  })
}

let grid = ''
try {
  const { code, output } = await runVshot()
  try {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    grid = payload.grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
  } catch {
    /* no grid written — the boot itself died */
  }
  if (code !== 0) {
    check('the drive completed', false, output.split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300))
    if (grid !== '') console.error('── the stalled frame ──\n' + grid.split('\n').slice(0, 30).join('\n'))
  } else {
    const keep = process.env.FIRSTRUN_CAPTURE_DIR
    if (keep) {
      mkdirSync(keep, { recursive: true })
      writeFileSync(join(keep, 'firstrun-kimi-guardrails-100.txt'), grid)
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
  server.close()
}

// The walk advanced ONLY through the settled ok (esc/cancel would have
// returned to the catalogue): Guardrails on screen with sign-in walked.
check('the walk advanced to Guardrails on the settled Kimi sign-in', grid.includes('Guardrails') && grid.includes('guardrails · 3/5'))
check('the rail marks the sign-in station walked', grid.includes('sign in'))
check('the fixture saw ONE device-authorization start', deviceStarts === 1, `starts=${deviceStarts}`)
check('the device grant polled pending → authorized on the pinned OAuth host', tokenPolls >= 2, `polls=${tokenPolls}`)
check(
  'the fresh bearer was proven live on the CODING base (GET /usages)',
  hits.some(hit => hit.path === '/kimi/coding/v1/usages' && hit.bearer === KIMI_ACCESS),
  JSON.stringify(hits.map(hit => hit.path)),
)
check('no request ever carried the refresh token as a bearer', !hits.some(hit => hit.bearer === KIMI_REFRESH))
check('no secret painted on the final frame', !grid.includes(KIMI_ACCESS) && !grid.includes(KIMI_REFRESH))

console.log(failures === 0 ? '\nFIRSTRUN KIMI LEG: ALL GREEN' : `\nFIRSTRUN KIMI LEG: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
