#!/usr/bin/env bun
// ============================================================================
//  prove-defaultprovider-restart-drive — the /defaultprovider persistence
//  law on the BUILT artifact, across a REAL restart (two PTY boots of one
//  scratch home):
//
//    boot 1 · two env keys (GLM and DeepSeek — credentials with no recorded
//             sign-in, so the registry order leads and the face shows the
//             GLM lane, never DeepSeek); the chat's `/defaultprovider
//             deepseek` (the client's own local-jsx surface — the arg
//             grammar) records the operator switch in the sign-in ledger
//             and its receipt names the switched lane + the resolved
//             default model;
//    boot 2 · the SAME home boots again — the face's Model line now names
//             the DeepSeek frontier pin: the ledger entry survived restart
//             and the computed default honours it over the untimed GLM key
//             (no /model pick, no env model, nothing but the recorded word
//             + the lane's DEEPSEEK_API_KEY credential).
//
//  Hermetic: scratch home, dead Anthropic base, fixture DeepSeek and GLM
//  keys (pin-table lanes — zero catalogue traffic needed for a default).
//
//  Run: ~/.bun/bin/bun run scripts/default-provider/prove-defaultprovider-restart-drive.ts
// ============================================================================
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

type Grid = Array<Array<{ c?: string }>>
async function capture(
  tag: string,
  cfg: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ text: string; marks: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), `defaultprovider-drive-${tag}-`))
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
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    marks?: Array<{ label: string; grid: Grid }>
  }
  const gridText = (grid: Grid): string =>
    grid
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  return { text: gridText(payload.grid), marks }
}

console.log('============================================================')
console.log(' /defaultprovider restart drive — set · restart · still the default')
console.log('============================================================')

const home = mkdtempSync(join(realpathSync(tmpdir()), 'defaultprovider-home-'))
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
const env: Record<string, string> = {
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
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  DEEPSEEK_API_KEY: 'fixture-deepseek-key-123',
  ZAI_API_KEY: 'fixture-zai-key-123',
}

// ── boot 1: the switch ──────────────────────────────────────────────────────
{
  const { marks } = await capture(
    'boot1',
    {
      cols: 100,
      rows: 40,
      total: 140,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        { data: '', atTick: 999, awaitText: '↵ start', requireAwait: true, minTick: 8, awaitSettleTicks: 2, mark: 'face1' },
        { data: '\r', afterPrevTicks: 2 },
        { data: '/defaultprovider deepseek\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', atTick: 999, awaitText: 'Default provider set to DeepSeek', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'receipt' },
      ],
      // NO readyText: it is the POST-SENDS end gate (birth semantics), and
      // this journey's sends LEAVE the face a face needle would name — the
      // end-gate trap. The ready burden rides the sends themselves: the
      // first awaits the face's start hint (requireAwait), the last awaits
      // the receipt (requireAwait) — the journey proves its own arrival.
      stableTicks: 4,
    },
    env,
  )
  const face1 = (marks.face1 ?? '').replace(/\s+/g, ' ')
  check('boot 1: two untimed env keys and no ledger — the registry order leads (the GLM lane), never DeepSeek, never "no sign-in yet"', !face1.includes('DeepSeek V4') && !face1.includes('deepseek-v4') && !face1.includes('no sign-in yet'), face1.slice(0, 160))
  const receipt = (marks.receipt ?? '').replace(/\s+/g, ' ')
  check(
    'the receipt names the switch + the resolved default model',
    receipt.includes('Default provider set to DeepSeek') && receipt.includes('deepseek-v4-pro'),
    receipt.slice(-260) || '(no receipt frame)',
  )
  const ledger = JSON.parse(readFileSync(join(home, '.sign-ins.json'), 'utf8')) as {
    signIns?: Record<string, { kind?: string }>
  }
  check("the switch landed in the sign-in ledger ('deepseek', an operator switch) — no config field", ledger.signIns?.deepseek?.kind === 'operator-switch', JSON.stringify(ledger))
}

// ── boot 2: the restart truth ───────────────────────────────────────────────
{
  const { marks } = await capture(
    'boot2',
    {
      cols: 100,
      // The strip (Model · Theme · Dir / Acct · Health) is the face's model
      // line, and the boot ladder SHEDS it at 100×40 by design (the
      // head-bare tier: head art + tight card, the strip degraded first —
      // splash-core's F2 rung), so a 40-row capture can never carry the
      // Model line whatever the default resolved to; 50 rows fit the head,
      // the ten-row card and the strip, and the line paints.
      rows: 50,
      total: 90,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        // Gate on the face's ready line (the same needle boot 1 awaits —
        // it rides the card, so the card is on screen), then settle and
        // mark: the Model line is asserted on the marked frame below, so a
        // missing strip fails the CHECK with the frame in hand instead of a
        // stuck send with no frame at all.
        { data: '', atTick: 999, awaitText: '↵ start', requireAwait: true, minTick: 8, awaitSettleTicks: 4, mark: 'face' },
      ],
      // NO readyText (the end-gate lesson): the ready-line await IS the
      // ready burden — requireAwait refuses the run if the face never
      // paints, and the mark hands the check its own frame.
      stableTicks: 4,
    },
    env,
  )
  const face = (marks.face ?? '').replace(/\s+/g, ' ')
  check('boot 2: the face paints its strip at this geometry (the Model line exists on the frame)', /\bModel\s/.test(face), face.slice(-400))
  check(
    'boot 2: the face Model line names the DeepSeek default (the operator switch survived restart and outranks the untimed GLM key)',
    /Model\s+(DeepSeek V4 Pro|deepseek-v4-pro)/.test(face),
    face.slice(-400),
  )
}

console.log(
  failures === 0
    ? '\n✅ prove-defaultprovider-restart-drive — all checks pass'
    : '\n❌ prove-defaultprovider-restart-drive — check(s) failed',
)
process.exit(failures === 0 ? 0 : 1)
