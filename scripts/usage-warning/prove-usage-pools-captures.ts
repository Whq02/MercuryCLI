#!/usr/bin/env bun
// ============================================================================
//  prove-usage-pools-captures — the per-model weekly pools are VISIBLE on
//  the real surfaces, driven through the built TUI in a PTY (vshot), from
//  the armed subscription-usage fixture (zero network; the operator's own
//  three-meter frame, session 36% · all-models week 44% · one per-model
//  week at 87% — here the OPUS week, because the seeded session model is
//  Opus 5, with the Fable and Sonnet weeks beside it):
//
//    · THE RAIL (160 columns, the both-rails cockpit): after /usage folds
//      the fixture into the one record, the telemetry rail's USAGE panel
//      paints the shared pair AND every pool the endpoint stated, each
//      with its percent and its coarse reset — 'Opus ▰▰▰▰ 87% 22h' — and
//      the strip names the pool of the session model's OWN family.
//    · THE BAND (120 columns, the inline home — cockpit and deck off): the
//      frame band's second chip is the BINDING window for the session
//      model — 'Opus … 87%' beside the 5h chip, where the 7d chip at 44%
//      used to hide it.
//
//  Both legs ride the CLIENT surfaces deliberately (the /usage panel is the
//  client's own, and its mount fetch folds the fixture where the rail and
//  the band read). The pool rows are steady state — every assertion reads
//  the MARK frame its await observed. USAGE_POOLS_SHOT_DIR=<dir> banks each
//  mark frame as <tag>.<label>.txt and the grid JSON as <tag>.grid.json.
//
//  Run: ~/.bun/bin/bun run scripts/usage-warning/prove-usage-pools-captures.ts
// ============================================================================
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const SHOT_DIR = process.env.USAGE_POOLS_SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

type Send = {
  data: string
  atTick?: number
  minTick?: number
  awaitText?: string
  awaitSettleTicks?: number
  awaitStableTicks?: number
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
}

async function capture(tag: string, cfg: Record<string, unknown>, env: Record<string, string>): Promise<CaptureResult> {
  const dir = mkdtempSync(join(tmpdir(), `usage-pools-shot-${tag}-`))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
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
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(SHOT_DIR, `${tag}.${label}.txt`), frame)
    writeFileSync(join(SHOT_DIR, `${tag}.final.txt`), text)
  }
  return {
    text,
    flat: text.replace(/\s+/g, ' '),
    marks,
    sends: Array.isArray(cfg.sends) ? (cfg.sends as unknown[]).length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
  }
}

function seedHome(): { home: string; workspace: string } {
  // The session model is PINNED (settings.model) so the binding pool is a
  // fact of the fixture, never of the catalogue's frontier on the box.
  // realpath'd tmpdir: macOS hands out the /var symlink while the boot
  // realpaths its cwd — a trust record keyed on the symlink spelling never
  // matches and the drive walks into the trust wall.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'usage-pools-home-'))
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
  // The seeded subscriber: a max account whose token carries the inference
  // + profile scopes and a far future expiry (file store).
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
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_OPERATOR: 'sam',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: 'true',
    // Machine-independence: the operator's real credentials never leak in.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    MERCURY_MOCK_LIMITS: '1',
    MERCURY_MOCK_USAGE_PAYLOAD: JSON.stringify({
      five_hour: { utilization: 36, resets_at: new Date(Date.now() + 2 * 3600e3 + 10 * 60e3).toISOString() },
      seven_day: { utilization: 44, resets_at: new Date(Date.now() + 6 * 24 * 3600e3 + 3 * 3600e3).toISOString() },
      seven_day_fable: { utilization: 61, resets_at: new Date(Date.now() + 6 * 24 * 3600e3).toISOString() },
      seven_day_opus: { utilization: 87, resets_at: new Date(Date.now() + 22 * 3600e3 + 51 * 60e3).toISOString() },
      seven_day_sonnet: { utilization: 20, resets_at: new Date(Date.now() + 6 * 24 * 3600e3).toISOString() },
    }),
  }
}

// The face-↵ prelude (the landing rule: a bare boot lands on the Boot face)
// then the composer gate — strict throughout: a frame that never paints is
// vshot's own undelivered-sends refusal, never blind typing.
const FACE_THEN_COMPOSER: Send[] = [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 },
]
const BAR = '[█░▰▱]{2,4}'

console.log('============================================================')
console.log(' usage pool captures — the rail at 160 cols · the band at 120 cols')
console.log('============================================================')

// ── §1 the rail: every stated pool under the shared pair ────────────────────
{
  const { home, workspace } = seedHome()
  const { marks, sends, receipts } = await capture(
    'rail-160',
    {
      cols: 160,
      rows: 45,
      total: 260,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_COMPOSER,
        // /usage opens the CLIENT panel; its mount fetch takes the armed
        // payload and folds every window and pool into the one record.
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Current week (Opus)', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
        // Back in the chat, the rail repaints from the record: the pool
        // rows are steady state — the mark is the frame the await observed.
        { data: '', atTick: 999, awaitText: 'Sonnet', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'pools' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home),
  )
  console.log('\nthe rail · 160 cols')
  check('every send became due', sends > 0 && receipts === sends)
  const frame = marks.pools ?? ''
  const lines = frame.split('\n').map(l => l.replace(/\s+/g, ' '))
  const row = (re: RegExp): string | undefined => lines.find(l => re.test(l))
  check('the USAGE panel is on the rail', /USAGE/.test(frame), frame.slice(0, 200) || '(no frame)')
  check(`the shared pair paints first — 5h 36%`, row(new RegExp(`5h ${BAR} 36%`)) !== undefined, lines.filter(l => /5h/.test(l)).join(' | '))
  check(`…and 7d 44%`, row(new RegExp(`7d ${BAR} 44%`)) !== undefined, lines.filter(l => /7d/.test(l)).join(' | '))
  check(`the Fable pool paints under the pair at 61%`, row(new RegExp(`Fable ${BAR} 61%`)) !== undefined, lines.filter(l => /Fable/.test(l)).join(' | '))
  check(`the Opus pool paints at 87% with its coarse reset (22h)`, row(new RegExp(`Opus ${BAR} 87% 22h`)) !== undefined, lines.filter(l => /Opus/.test(l)).join(' | '))
  check(`the Sonnet pool paints at 20%`, row(new RegExp(`Sonnet ${BAR} 20%`)) !== undefined, lines.filter(l => /Sonnet/.test(l)).join(' | '))
  const order = ['5h ', '7d ', 'Fable ', 'Opus ', 'Sonnet '].map(k => lines.findIndex(l => l.includes(k) && new RegExp(`${k.trim()} ${BAR}`).test(l)))
  check('the block reads pair then pools, top to bottom', order.every(i => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]!), order.join(','))
  check("the strip warning names the session model's OWN pool — the Opus week at 87% — never the Fable week", /87% of Opus limit used/.test(frame) && !/of Fable limit used/.test(frame), lines.filter(l => /limit used/.test(l)).join(' | '))
}

// ── §2 the band: the binding window is the second chip ──────────────────────
{
  const { home, workspace } = seedHome()
  const { marks, sends, receipts } = await capture(
    'band-120',
    {
      cols: 120,
      rows: 40,
      total: 260,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_COMPOSER,
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '\x1b', atTick: 999, awaitText: 'Current week (Opus)', requireAwait: true, minTick: 4, awaitSettleTicks: 4 },
        // The band repainted on the fold itself (the record's change
        // signal), so the chips are on screen the moment the chat is back;
        // the percent is the needle (the greeting names the model too).
        { data: '', atTick: 999, awaitText: '87%', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'band' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    {
      ...baseEnv(home),
      // The inline home: the cockpit rails and the deck strip are off, so
      // the frame band keeps its own usage chips.
      MERCURY_HELM_HOME: '0',
      MERCURY_SUBSTRATE: '0',
    },
  )
  console.log('\nthe band · 120 cols')
  check('every send became due', sends > 0 && receipts === sends)
  const frame = marks.band ?? ''
  const flat = frame.replace(/\s+/g, ' ')
  check(`the band keeps the 5h chip (5h … 36%)`, new RegExp(`5h ${BAR} 36%`).test(flat), flat.slice(-400) || '(no frame)')
  check(`the band's second chip is the BINDING window — Opus 87%, not the 7d at 44%`, new RegExp(`Opus ${BAR} 87%`).test(flat), flat.slice(-400))
  check('…so the 7d chip yields the cell to the pool that binds', !new RegExp(`7d ${BAR} 44%`).test(flat), flat.slice(-400))
}

console.log(failures === 0 ? '\n✅ prove-usage-pools-captures — all checks pass' : '\n❌ prove-usage-pools-captures — check(s) failed')
process.exit(failures === 0 ? 0 : 1)
