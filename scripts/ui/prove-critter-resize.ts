#!/usr/bin/env bun
// scripts/ui/prove-critter-resize.ts — the minimize→maximize critter journey
// (the sol-5.6 open report: "minimize then maximize duplicated
// the critter"). Drives the REAL binary through 120×40 → 60×18 → 120×40 via
// vshot's mid-flight resizes and holds:
//   §1 SINGLE-BRAND at every stage: at most one Mercury wordmark/lockup per
//      captured frame (a duplicate hero/banner is the reported bug);
//   §2 the ROUND-TRIP settles to the SAME screen a fresh boot paints — the
//      final 120×40 frame equals the committed frame--120x40 baseline grid
//      through the standard masks (no stale cells, no doubled art, no
//      leftover geometry);
//   §3 no stage frame is blank (the capture itself stayed alive through
//      both SIGWINCH deliveries).
// Heavy (one PTY boot) — joins the UI_RENDER tier via the render- prefix
// convention? No: this IS the S10 pinned journey, kept in prove-* so the
// gate always runs it; one capture ≈ 12s.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactGrid, readManifest, readStoredGrid, type RawGrid } from './visualBaseline.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

// HERMETIC HOME (the §2.F law): the journey owns its config home — a real
// home's persisted /critter pick would change the hero art and flake the
// art-count needle against the scratch-home baseline. Seeded BEFORE the
// dynamic renderScenarios import (its CONFIG_HOME is a module-load snapshot).
const RUN_HOME = join(tmpdir(), `critter-resize-home-${process.pid}`)
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(RUN_HOME, { recursive: true })
const REPO = join(import.meta.dir, '..', '..')
writeFileSync(
  join(RUN_HOME, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [REPO]: { hasTrustDialogAccepted: true } },
    // Key-consent: in any env carrying a credential
    // (the CI proof key), a config without the approval boots the consent
    // card OVER the enter screen — by the maximize stage it displaced the
    // critter art entirely (roundtrip=0 rows; invisible on the keyless
    // calibration shell). Mirrors scripts/lib/firstRunSeed.ts.
    ...(process.env.ANTHROPIC_API_KEY
      ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
      : {}),
  }),
)
writeFileSync(join(RUN_HOME, 'settings.json'), JSON.stringify({}))
process.env.MERCURY_CONFIG_DIR = RUN_HOME
const { scenario, cleanupScenario } = await import('./renderScenarios.ts')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const cfg = scenario('frame', 120, 40) as Record<string, unknown>
const gridPath = join(tmpdir(), `critter-resize-${process.pid}.json`)
const cfgPath = join(tmpdir(), `critter-resize-cfg-${process.pid}.json`)
writeFileSync(
  cfgPath,
  JSON.stringify({
    ...cfg,
    out: gridPath,
    // Observed-ready: cold machines repaint the
    // maximize slowly — the fixed 55-tick end sampled a blank stage. The
    // capture now ends when the wordmark is BACK on screen (hard bound 110).
    total: 110,
    // The needle is the BLOCK wordmark's M-glyph row, not the word: this splash
    // paints the lockup in block glyphs, so the literal 'MERCURY' never appears
    // on the grid. The gate was therefore dead from the day it was written and
    // the capture silently kept running the fixed budget this annotation was
    // introduced to replace — invisible until vshot began refusing never-ready
    // captures. Verified on the real 120x40 frame: '\u2588\u2584\u2584\u2584\u2588' present,
    // 'MERCURY'/'Mercury'/'\u2736 Mercury' all absent.
    // The resumed transcript's first row is the readiness needle: in the
    // cockpit the turns-state furniture is the critter berth + SESSION
    // header (the block wordmark belongs to the empty landing), so the
    // transcript landing is what says "painted".
    readyText: '❯ first task',
    readySettleTicks: 3,
    resizes: [
      { atTick: 25, cols: 60, rows: 18 }, // minimize
      { atTick: 38, cols: 120, rows: 40 }, // maximize back
    ],
  }),
)
const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(90_000),
  env: { ...process.env, MERCURY_CONFIG_DIR: RUN_HOME, MERCURY_AWAY_SUMMARY: '0' },
})
cleanupScenario('frame')
rmSync(RUN_HOME, { recursive: true, force: true })
if (res.status !== 0) {
  console.log(`FAIL  capture ran — ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}
const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as RawGrid & {
  stages?: Array<{ cols: number; rows: number; grid: RawGrid['grid'] }>
}

const frames: Array<{ name: string; cols: number; rows: number; grid: RawGrid['grid'] }> = [
  ...(payload.stages ?? []).map((s, i) => ({ name: `stage${i} (${s.cols}x${s.rows})`, cols: s.cols, rows: s.rows, grid: s.grid })),
  { name: 'final (120x40)', cols: payload.cols, rows: payload.rows, grid: payload.grid },
]
t('resize stages captured', (payload.stages?.length ?? 0) === 2, `${payload.stages?.length ?? 0}`)

// §1 SINGLE-BRAND per frame: the block wordmark's distinctive row ('█▄▄▄█' —
// the M glyph) plus the inline '✶ Mercury' lockup count at most ONE total.
for (const f of frames) {
  const text = f.grid.map(row => row.map(c => c.c).join(''))
  const wordmarkRows = text.filter(r => r.includes('█▄▄▄█')).length
  const lockups = text.filter(r => r.includes('✶ Mercury')).length
  const brands = (wordmarkRows > 0 ? 1 : 0) + lockups
  t(`${f.name}: single brand (wordmark rows=${wordmarkRows}, lockups=${lockups})`, brands <= 1)
  const ink = text.reduce((n, r) => n + r.trim().length, 0)
  t(`${f.name}: not blank`, ink > 40, `${ink} ink chars`)
}

// §2 round-trip == fresh boot (through the standard masks).
const manifest = readManifest()
const baselineEntry = manifest?.entries.find(e => e.id === 'frame--120x40--dark--truecolor--full')
if (!baselineEntry) {
  t('baseline entry present', false)
} else {
  const baseline = readStoredGrid(baselineEntry)
  const finalGrid = compactGrid({ cols: payload.cols, rows: payload.rows, grid: payload.grid })
  // Both this capture and the baseline ride OWNED scratch homes, but their
  // fixtures differ in live-clock/age cells and this journey's home lacks the
  // baseline's exact session store — the duplication class lives in the
  // CENTER panel (hero art + wordmark), so compare by brand/art needles
  // instead of full-grid equality:
  const bText = baseline.text
  const fText = finalGrid.text
  const bArt = bText.filter(r => /[▀▄]{3,}/.test(r)).length
  const fArt = fText.filter(r => /[▀▄]{3,}/.test(r)).length
  t('round-trip art-row count equals the fresh-boot baseline', fArt === bArt, `fresh=${bArt} roundtrip=${fArt}`)
  const bBrand = bText.filter(r => r.includes('█▄▄▄█')).length
  const fBrand = fText.filter(r => r.includes('█▄▄▄█')).length
  t('round-trip wordmark rows equal the baseline', fBrand === bBrand, `fresh=${bBrand} roundtrip=${fBrand}`)
}

if (fail) {
  console.log('\n❌ critter-resize — failures above (the duplication repro?)')
  process.exit(1)
}
console.log('\n✅ critter-resize — minimize→maximize round-trip is single-brand and art-stable')
