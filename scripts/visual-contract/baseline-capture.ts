#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/baseline-capture.ts — R0: the BEFORE
//  captures of every surface the will touch (operator brief CN-01),
//  taken from the untouched tree (splash asset via ONESHOT; in-app surfaces
//  from the SHIPPED dist via renderScenarios/render-tui).
//
//  NOT a pool prover — a deliberate capture tool, the INTERVIEW
//  baseline-capture pattern. Artifacts land in scripts/visual-contract/baselines/
//  as pyte cell-grids (<surface>-<cols>x<rows>[-<leg>].json) and are
//  committed as the R0 record. Candidate trees are diffed against these
//  captures at Waves B–D (CN-09's geometry grid-compare, CN-15's matrix).
//
//  Size matrix (the brief): 45×12 · 60×18 · 80×24 · 100×30 · 120×40 · 150×45.
//  Legs where supported: the splash gets reduced-motion (MERCURY_REDUCED_MOTION
//  =1) and reduced-colour (TERM=linux ⇒ the 256 fallback path) legs at 80×24;
//  in-app light/reduced legs are NOT env-switchable in this harness (theme
//  lives in the settings store) — recorded in the R0 journal, not silently
//  skipped. Views that cannot fit a size (menu needs cols≥64 ∧ rows≥13,
//  projects needs cols≥64 ∧ rows≥n+9) are logged as skipped, never captured
//  as silent lockup fallbacks.
//
//  Run:  ~/.bun/bin/bun run scripts/visual-contract/baseline-capture.ts [--only splash]
//  Requires the prebuilt dist (bun run build.ts) for the in-app surfaces.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = resolve(import.meta.dir, '../..')
const OUT = join(import.meta.dir, 'baselines')
const SPLASH = join(REPO, 'assets/splash/mercury-splash.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
mkdirSync(OUT, { recursive: true })

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1] : null
})()

const SIZES: Array<[number, number]> = [
  [45, 12],
  [60, 18],
  [80, 24],
  [100, 30],
  [120, 40],
  [150, 45],
]

// ── the splash fixture world (prove-splash.py's make_populated_home shape) ──
// Two recent projects with live cwds → the launcher card gains Continue +
// Projects rows and the projects picker has two entries. The home is tmp, so
// the scanner's proof-world carve-out honors tmp cwds.
function makePopulatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'contour-splash-home.'))
  for (const slug of ['proj-a', 'proj-b']) {
    const cwd = join(home, 'fixtures', slug)
    mkdirSync(cwd, { recursive: true })
    const pdir = join(home, 'projects', slug)
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'session.jsonl'), JSON.stringify({ cwd }) + '\n')
  }
  return home
}

function captureSplash(
  name: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'contour-vshot.'))
  const cfgPath = join(scratch, 'cfg.json')
  const gridPath = join(OUT, `${name}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: ['node', SPLASH], cols, rows, total: 10, out: gridPath }),
  )
  const r = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
    timeout: vshotBudgetMs(120_000),
  })
  const ok = r.status === 0 && existsSync(gridPath)
  console.log(`${ok ? '✅' : '❌'} ${name}.json`)
  if (!ok) console.log(String(r.stdout) + String(r.stderr))
  return ok
}

function captureScenario(scenarioName: string, cols: number, rows: number): boolean {
  const png = join(tmpdir(), `contour-${scenarioName}-${cols}x${rows}.png`)
  const r = spawnSync(
    process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun'),
    ['run', 'scripts/ui/render-tui.ts', '--scenario', scenarioName, '--cols', String(cols), '--rows', String(rows), '--out', png],
    { cwd: REPO, stdio: 'pipe', timeout: vshotBudgetMs(180_000) },
  )
  // render-tui writes the grid beside its PNG contract at /tmp/grid-<cols>.json.
  const grid = `/tmp/grid-${cols}.json`
  const dest = join(OUT, `${scenarioName}-${cols}x${rows}.json`)
  const ok = r.status === 0 && existsSync(grid)
  if (ok) copyFileSync(grid, dest)
  console.log(`${ok ? '✅' : '❌'} ${scenarioName}-${cols}x${rows}.json`)
  if (!ok) console.log(String(r.stdout).slice(-2000) + String(r.stderr).slice(-2000))
  return ok
}

let fail = 0
const HOME_SPELLINGS = ['MERCURY_HOME', 'MERCURY_CONFIG_DIR']

// ── splash: lockup / menu / projects across the matrix ──────────────────────
if (!only || only === 'splash') {
  const home = makePopulatedHome()
  const base: Record<string, string> = {
    MERCURY_SPLASH_ONESHOT: '1',
    TERM: 'xterm-256color',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
  }
  for (const s of HOME_SPELLINGS) base[s] = home
  const nPicker = 2 // both fixture projects differ from this process's cwd

  for (const [cols, rows] of SIZES) {
    if (!captureSplash(`splash-lockup-${cols}x${rows}`, cols, rows, base)) fail++
    if (cols >= 64 && rows >= 13) {
      if (!captureSplash(`splash-menu-${cols}x${rows}`, cols, rows, { ...base, MERCURY_SPLASH_VIEW: 'menu' })) fail++
    } else console.log(`— splash-menu-${cols}x${rows}: menu cannot fit (needs cols≥64 ∧ rows≥13) — skipped by contract`)
    if (cols >= 64 && rows >= nPicker + 9) {
      if (!captureSplash(`splash-projects-${cols}x${rows}`, cols, rows, { ...base, MERCURY_SPLASH_VIEW: 'projects' })) fail++
    } else console.log(`— splash-projects-${cols}x${rows}: picker cannot fit (needs cols≥64 ∧ rows≥${nPicker + 9}) — skipped by contract`)
  }
  // The supported legs at 80×24.
  if (!captureSplash('splash-lockup-80x24-reduced-motion', 80, 24, { ...base, MERCURY_REDUCED_MOTION: '1' })) fail++
  if (!captureSplash('splash-lockup-80x24-reduced-colour', 80, 24, { ...base, TERM: 'linux' })) fail++
}

// ── in-app surfaces from the SHIPPED dist ───────────────────────────────────
const APP_SURFACES = ['cockpit-mission', 'model-picker-home', 'thinking-row']
for (const surface of APP_SURFACES) {
  if (only && only !== surface && only !== 'app') continue
  for (const [cols, rows] of SIZES) {
    if (!captureScenario(surface, cols, rows)) fail++
  }
}

console.log(fail === 0 ? '\n✅ contour BEFORE captures complete' : `\n❌ ${fail} capture(s) failed`)
process.exit(fail === 0 ? 0 : 1)
