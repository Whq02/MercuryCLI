#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-size-matrix.ts — §7: the required terminal
//  matrix, exercised against the REAL TUI. Every size boots through
//  render-tui's oracle (blank/boot-error/chrome-less captures REJECT), then
//  the settled grid is swept for the geometry laws a human would spot:
//   · no dialog/footer line ends with a dangling '·' separator;
//   · no wrapped-border fragment rows (a lone '╮'/'╯' at column 0 — the
//     "border broke mid-frame" class);
//   · the composer chrome is present (the surface stayed usable).
//
//  Sizes: 60×20 · 80×24 · 100×30 · 120×40 · 150×45 (the §7 matrix; the
//  canonical 80/120 visual-baseline sizes are inside it — the live baseline
//  check pins those exactly).
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-size-matrix.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_HOME, RUNTIME_CWD } from '../ui/renderScenarios.js'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SIZES: Array<[number, number]> = [
  [60, 20],
  [80, 24],
  [100, 30],
  [120, 40],
  [150, 45],
]

for (const [cols, rows] of SIZES) {
  console.log(`\n== ${cols}×${rows} ==`)
  const gridPath = `/tmp/grid-${cols}.json`
  let bootOk = true
  try {
    execFileSync(
      process.execPath,
      ['run', join(root, 'scripts/ui/render-tui.ts'), '--scenario', 'resume-2turn', '--cols', String(cols), '--rows', String(rows), '--out', `/tmp/compass-size-${cols}x${rows}.png`],
      // cwd = the SESSION-STAGING path (renderScenarios' hardcoded slug), not
      // `root`: in the main checkout the two coincide, but a worktree run
      // inheriting the worktree cwd 404s every scenario on
      // "No conversation found" (the documented RUNTIME_CWD constraint).
      { encoding: 'utf-8', timeout: vshotBudgetMs(150_000), cwd: RUNTIME_CWD },
    )
  } catch (e) {
    bootOk = false
    check(`boots + passes the render oracle`, false, String(e).slice(0, 160))
  }
  if (!bootOk) continue
  check('boots + passes the render oracle', true)

  // vshot grid shape: { cols, rows, grid: cell[][] } with cell.c the glyph.
  const grid = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
  }
  const rowsText: string[] = grid.grid.map(row =>
    row.map(cell => cell.c).join('').replace(/\s+$/, ''),
  )

  // No dangling '·' separator at any visual line end (the help-footer law).
  const dangling = rowsText.filter(l => /·\s*$/.test(l))
  check('no line ends with a dangling separator', dangling.length === 0, dangling[0]?.trim().slice(-40))

  // No orphaned border fragment: a line whose ONLY content is border glyphs
  // shorter than 3 cells (a wrapped border corner stranded by overflow).
  const orphan = rowsText.filter(l => {
    const t = l.trim()
    return t.length > 0 && t.length <= 2 && /^[╭╮╰╯│─]+$/.test(t)
  })
  check('no wrapped-border fragments', orphan.length === 0, orphan[0]?.trim())

  // The composer chrome survived (usable surface).
  const hasPrompt = rowsText.some(l => l.includes('❯') || l.includes('for shortcuts'))
  check('the composer chrome is present', hasPrompt)
}

// ── MINI-TEMPER blocker B1: the sub-60×20 TRANSIENT-RESIZE journey ──────────
// One real-binary run: boot at 120×40 → shrink THROUGH the emergency band to
// 50×15 → return to 120×40. vshot snapshots each outgoing geometry's final
// frame (stages[]) + the settled final grid; every stage obeys the same laws
// (no dangling separators, no orphaned border fragments) and the surface
// SURVIVES the round-trip (composer chrome present at the settled 120×40).
console.log('\n== transient resize: 120×40 → 50×15 → 120×40 (one journey) ==')
{
  const { writeFileSync } = await import('node:fs')
  const { scenario } = await import('../ui/renderScenarios.js')
  const gridPath = '/tmp/compass-transient-resize.json'
  const cfg = {
    ...scenario('resume-2turn', 120, 40),
    out: gridPath,
    total: 42,
    resizes: [
      { atTick: 22, cols: 50, rows: 15 },
      { atTick: 32, cols: 120, rows: 40 },
    ],
  }
  const cfgPath = '/tmp/compass-transient-resize-cfg.json'
  writeFileSync(cfgPath, JSON.stringify(cfg))
  let ok = true
  try {
    execFileSync('/usr/bin/python3', [join(root, 'scripts/ui/vshot.py'), cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(150_000),
      cwd: RUNTIME_CWD,
      env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
    })
  } catch (e) {
    ok = false
    check('the transient-resize journey runs', false, String(e).slice(0, 160))
  }
  if (ok) {
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as {
      grid: Array<Array<{ c: string }>>
      stages?: Array<{ cols: number; rows: number; grid: Array<Array<{ c: string }>> }>
    }
    const toRows = (g: Array<Array<{ c: string }>>): string[] =>
      g.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, ''))
    const stages = payload.stages ?? []
    check('both resize stages snapshotted', stages.length === 2, String(stages.length))
    for (const st of stages) {
      const rowsText = toRows(st.grid)
      check(`stage ${st.cols}×${st.rows}: no dangling separator`, !rowsText.some(l => /·\s*$/.test(l)))
      check(
        `stage ${st.cols}×${st.rows}: no wrapped-border fragments`,
        !rowsText.some(l => {
          const t = l.trim()
          return t.length > 0 && t.length <= 2 && /^[╭╮╰╯│─]+$/.test(t)
        }),
      )
    }
    const finalRows = toRows(payload.grid)
    check('the surface SURVIVES the round-trip (composer chrome at the settled 120×40)',
      finalRows.some(l => l.includes('❯') || l.includes('for shortcuts')))
  }
}

console.log('')
if (failures > 0) {
  console.log(`❌ size-matrix: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ size-matrix — 60×20 → 150×45 boot clean + the 50×15 transient-resize round-trip; no dangling separators, no border fragments')
