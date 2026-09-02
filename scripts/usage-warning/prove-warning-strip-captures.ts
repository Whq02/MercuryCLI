#!/usr/bin/env bun
// ============================================================================
//  prove-warning-strip-captures — the yellow approaching-limit line ON THE
//  REAL STRIP (the composer footer's notice column), driven through the
//  built TUI in a PTY (vshot), for TWO provider fixtures at BOTH sizes
//  (100 + 120 columns):
//
//    · ANTHROPIC — the seeded subscriber home + the armed
//      MERCURY_MOCK_USAGE_PAYLOAD seam: /usage's mount fetch folds the 7d
//      meter at 92% into the one claudeAiLimits record, and the strip
//      paints "Anthropic: 92% of weekly limit used · resets …" (the meter
//      feeder — the endpoint states the percent; no header status needed).
// · ANTHROPIC, THE FABLE POOL — the operator's own
//      frame: the endpoint states seven_day_fable at 99% beside an
//      all-models week at 51%; the fold lands the pool in the same record
//      and the strip paints "Anthropic: 99% of Fable limit used · resets …"
//      (the base folded only 5h/7d and painted nothing).
//    · OPENROUTER — a loopback /key endpoint (ports 38000–38099; zero live
//      wires) serves the capped-credit truth; the session model rides the
//      openrouter lane (settings.model seed), /usage's mount observes the
//      cap, and the strip paints "OpenRouter: 84% of credit cap used"
//      on the engine feeders' re-read tick.
//
//  Both legs ride the CLIENT surfaces deliberately: on the daemon-hosted
//  cockpit chat, typed prompt text relays to the worker (whose process
//  state never reaches this client's strip) — /usage is the client's own
//  panel, so the observation lands where the warning owner reads.
//
//  The warning is a TRANSIENT notification (~8s) — every assertion reads
//  the MARK frame its await observed, never only the final grid.
//  USAGE_WARNING_SHOT_DIR=<dir> banks each mark frame as <tag>.txt and the
//  grid JSON as <tag>.grid.json (PNGs via gridToPng).
//
//  Run: ~/.bun/bin/bun run scripts/usage-warning/prove-warning-strip-captures.ts
// ============================================================================
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const SHOT_DIR = process.env.USAGE_WARNING_SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

type Send = {
  data: string
  atTick?: number
  minTick?: number
  awaitText?: string
  awaitSettleTicks?: number
  afterPrevTicks?: number
  requireAwait?: boolean
  mark?: string
}

interface CaptureResult {
  text: string
  flat: string
  sends: number
  receipts: number
  marks: Record<string, string>
  gridPath: string
}

async function capture(tag: string, cfg: Record<string, unknown>, env: Record<string, string>): Promise<CaptureResult> {
  const dir = mkdtempSync(join(tmpdir(), `usage-warning-shot-${tag}-`))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  // ASYNC spawn, deliberately: a sync spawn freezes this process's event
  // loop for the whole capture, and the loopback /key server below stops
  // accepting — the child's fetch then hangs forever ('fetching live credit
  // truth…') and the drive reads as a product red.
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      '/usr/bin/python3',
      [VSHOT, cfgPath],
      { env: { ...process.env, ...env }, timeout: vshotBudgetMs(240_000) },
      (error, _stdout, stderr) => {
        if (error) rejectRun(new Error(`${String(error)}\n${stderr}`))
        else resolveRun()
      },
    )
  })
  type Grid = Array<Array<{ c?: string }>>
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
  }
  const gridText = (grid: Grid): string =>
    grid
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const text = gridText(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  if (SHOT_DIR) {
    copyFileSync(outPath, join(SHOT_DIR, `${tag}.grid.json`))
    for (const [label, frame] of Object.entries(marks)) {
      writeFileSync(join(SHOT_DIR, `${tag}.${label}.txt`), frame)
    }
    writeFileSync(join(SHOT_DIR, `${tag}.final.txt`), text)
  }
  return {
    text,
    flat: text.replace(/\s+/g, ' '),
    marks,
    sends: Array.isArray(cfg.sends) ? (cfg.sends as unknown[]).length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
    gridPath: join(dir, 'grid.json'),
  }
}

function seedHome(withSettingsModel?: string): { home: string; workspace: string } {
  // realpath'd tmpdir: macOS hands out the /var symlink while the boot
  // realpaths its cwd — a trust record keyed on the symlink spelling never
  // matches and the drive walks into the trust wall.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'usage-warning-home-'))
  // The drive's cwd is a scratch WORKSPACE keyed into the trust record — a
  // cwd left at the repo checkout walks into the trust wall instead of the
  // Boot face (trust covers ancestors, so the workspace key is enough).
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    join(home, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  if (withSettingsModel !== undefined) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: withSettingsModel }))
  }
  return { home, workspace }
}

function baseEnv(home: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: 'true',
    // Machine-independence: the operator's real credentials never leak in.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
  }
}

// The face-↵ prelude (the landing rule: a bare boot lands on the Boot face)
// then the composer gate — strict throughout: a frame that never paints is
// vshot's own undelivered-sends refusal, never blind typing.
const FACE_THEN_COMPOSER: Send[] = [
  { data: '\r', atTick: 999, awaitText: '↵ start', requireAwait: true, minTick: 8, awaitSettleTicks: 3 },
]

console.log('============================================================')
console.log(' warning strip captures — Anthropic + OpenRouter, 100 + 120 cols')
console.log('============================================================')

// ── §1 anthropic: the armed mock seam drives the real ingestion ─────────────
for (const cols of [100, 120]) {
  const { home, workspace } = seedHome()
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
  const { marks, sends, receipts } = await capture(
    `anthropic-${cols}`,
    {
      cols,
      rows: 40,
      total: 200,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_COMPOSER,
        // /usage opens the CLIENT panel (the daemon-hosted chat relays
        // typed prompts to its worker, but local-jsx surfaces are the
        // client's own); its mount fetch takes the armed payload and folds
        // the 7d meter into the one claudeAiLimits record.
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Current week', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
        // Back in the chat, the meter feeder reaches the strip on the
        // engine re-read tick. The line is transient (~8s): the mark
        // snapshots the frame the await observed — the assertion's home.
        { data: '', atTick: 999, awaitText: 'of weekly limit used', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'warning' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    {
      ...baseEnv(home),
      MERCURY_MOCK_LIMITS: '1',
      MERCURY_MOCK_USAGE_PAYLOAD: JSON.stringify({
        five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3600e3).toISOString() },
        seven_day: { utilization: 92, resets_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() },
      }),
    },
  )
  console.log(`\nanthropic fixture · ${cols} cols`)
  check(`every send became due (${cols})`, sends > 0 && receipts === sends)
  const frame = (marks.warning ?? '').replace(/\s+/g, ' ')
  check(
    `the strip paints the ruled grammar (${cols})`,
    /Anthropic: 92% of weekly limit used · resets /.test(frame),
    frame.slice(-260) || '(no warning frame)',
  )
  check(`…with the warn lead (${cols})`, frame.includes('▲ Anthropic: 92%'), frame.slice(-140))
}

// ── §1b anthropic, the Fable pool: the per-model weekly bucket warns ────────
for (const cols of [100, 120]) {
  const { home, workspace } = seedHome()
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
  const { marks, sends, receipts } = await capture(
    `anthropic-fable-${cols}`,
    {
      cols,
      rows: 40,
      total: 200,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_COMPOSER,
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        // The tab paints the pool row too ("Current week (Fable)") — the
        // same observation the fold just landed in the record.
        { data: '\x1b', atTick: 999, awaitText: 'Current week (Fable)', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
        { data: '', atTick: 999, awaitText: 'of Fable limit used', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'warning' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    {
      ...baseEnv(home),
      MERCURY_MOCK_LIMITS: '1',
      MERCURY_MOCK_USAGE_PAYLOAD: JSON.stringify({
        five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3600e3).toISOString() },
        seven_day: { utilization: 51, resets_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() },
        seven_day_fable: { utilization: 99, resets_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() },
        seven_day_opus: { utilization: 12, resets_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() },
      }),
    },
  )
  console.log(`\nanthropic Fable-pool fixture · ${cols} cols`)
  check(`every send became due (${cols})`, sends > 0 && receipts === sends)
  const frame = (marks.warning ?? '').replace(/\s+/g, ' ')
  check(
    `the strip names the POOL, not the calm all-models week (${cols})`,
    /Anthropic: 99% of Fable limit used · resets /.test(frame),
    frame.slice(-260) || '(no warning frame)',
  )
  check(`…with the warn lead (${cols})`, frame.includes('▲ Anthropic: 99%'), frame.slice(-140))
}

// ── §2 openrouter: the loopback /key truth + the engine re-read tick ────────
const PORT = 38031
const server = createServer((req, res) => {
  if ((req.url ?? '').endsWith('/key')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: {
          label: 'usage-breadth fixture key',
          usage: 16.8,
          usage_daily: 1.1,
          usage_weekly: 4.2,
          usage_monthly: 16.8,
          limit: 20,
          limit_remaining: 3.2,
          is_free_tier: false,
        },
      }),
    )
    return
  }
  if ((req.url ?? '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'nvidia/nemotron-nano-9b-v2:free',
            name: 'NVIDIA Nemotron Nano 9B (free)',
            context_length: 131072,
            pricing: { prompt: '0', completion: '0' },
          },
        ],
        total_count: 1,
        links: { next: null },
      }),
    )
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
await new Promise<void>(resolvePort => server.listen(PORT, '127.0.0.1', resolvePort))

for (const cols of [100, 120]) {
  const { home, workspace } = seedHome('openrouter/nvidia/nemotron-nano-9b-v2:free')
  const { marks, sends, receipts } = await capture(
    `openrouter-${cols}`,
    {
      cols,
      rows: 40,
      total: 220,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_COMPOSER,
        // /usage mounts the tab; its mount observes the loopback /key truth.
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'OpenRouter', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
        // Back in the chat, the engine feeders' 15s re-read tick paints the
        // strip line — the await rides it out (wall-clock ticks).
        { data: '', atTick: 999, awaitText: 'of credit cap used', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'warning' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    {
      ...baseEnv(home),
      OPENROUTER_API_KEY: 'fixture-openrouter-key-1234',
      MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${PORT}/api/v1`,
    },
  )
  console.log(`\nopenrouter fixture · ${cols} cols`)
  check(`every send became due (${cols})`, sends > 0 && receipts === sends)
  const frame = (marks.warning ?? '').replace(/\s+/g, ' ')
  check(
    `the strip paints the ruled grammar (${cols})`,
    frame.includes('OpenRouter: 84% of credit cap used'),
    frame.slice(-260) || '(no warning frame)',
  )
  check(`…with the warn lead (${cols})`, frame.includes('▲ OpenRouter: 84%'), frame.slice(-140))
}

server.close()
console.log(
  failures === 0
    ? '\n✅ prove-warning-strip-captures — all checks pass'
    : '\n❌ prove-warning-strip-captures — check(s) failed',
)
process.exit(failures === 0 ? 0 : 1)
