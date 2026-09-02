#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-degradation-order.ts — the CN-14 degradation-order
//  laws, locked at each family's worst historical offender (
//  CN-15/CN-16).
//
//  THE FLOOR (ink/viewportFloor.ts — VIEWPORT_FLOOR_COLS × VIEWPORT_FLOOR_ROWS,
//  imported here so the legs follow the owner's number): under it no
//  fullscreen surface lays itself out — the host paints ONE line naming the
//  minimum and the way back. The worst historical offenders these families
//  were locked at (the 45×12 picker, the 45×12 composer) are windows the
//  product no longer paints a surface in, so each family's leg is the floor
//  itself: the smallest window a surface is designed for. The under-floor
//  line and the way back are the resize lane's pins
//  (compositor/prove-resize-ghost, ui/prove-resize-laws).
//
//  §1 MODAL family (the model picker at the floor): the card closes inside
//     the viewport — bottom border present, the focused row keeps its
//     selection frame, the cut is NAMED (`↓ N more`), the footer keeps its
//     esc close hint, and the banner STAYS: the full tier holds at the
//     floor (decoration sheds in the compact tier under 20 rows, a window
//     under the floor).
//
//  §2 INLINE-REPL family (the composer at the floor): a ❯ input line
//     renders inside a whole frame, the footer hint keeps both its parts
//     (the one-part shed lives under 50 columns, under the floor), and no
//     adjacent ╭/╰ border-only pair exists.
//
//  §3 TABLE family (MarkdownTable, the shared transcript-table owner): a
//     table cramped past its minimum word widths degrades to key/value
//     records — long header words stay INTACT (words never break); a table
//     that fits at 100 cols stays horizontal.
//
//  §4 RESIZE-CYCLE return (the splash — sendless, deterministic): driving
//     120×40 → 80×24 → the floor → 150×45 → 120×40 through real SIGWINCH
//     ends char-identical (volatile strip rows masked EXPLICITLY) to a
//     direct 120×40 boot — reflow leaves no residue. Every leg is at or
//     above the floor: the under-floor freeze and its return are the
//     resize lane's law, not a reflow.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS } from '../../src/ink/viewportFloor.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'contour-degrade-'))
type Cell = { c: string }
const gridLines = (path: string): string[] => {
  const g = (JSON.parse(readFileSync(path, 'utf8')) as { grid?: Cell[][] }).grid ?? []
  return g.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
}

function renderScenario(name: string, cols: number, rows: number): string[] {
  const r = spawnSync(
    process.execPath,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', name, '--cols', String(cols), '--rows', String(rows), '--grid', join(scratch, `${name}-${cols}x${rows}.json`), '--out', join(scratch, `${name}-${cols}x${rows}.png`)],
    { encoding: 'utf8', timeout: vshotBudgetMs(240_000) },
  )
  if (r.status !== 0) {
    console.log((r.stdout ?? '').slice(-800) + (r.stderr ?? '').slice(-800))
    return []
  }
  return gridLines(join(scratch, `${name}-${cols}x${rows}.json`))
}

t.section(`§1 — the modal family closes inside the floor viewport (${VIEWPORT_FLOOR_COLS}×${VIEWPORT_FLOOR_ROWS}, the full tier)`)
{
  const lines = renderScenario('model-picker-home', VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS)
  const all = lines.join('\n')
  const closes = lines.some(l => l.trimStart().startsWith('╰'))
  // A hosted red here was undiagnosable from the one-line detail (gate run
  // 30677930073) — on any failure, print the WHOLE grid.
  if (!closes) lines.forEach((l, i) => console.log(`      grid[${String(i).padStart(2, '0')}] ${JSON.stringify(l)}`))
  t.check('the card CLOSES: a bottom border row is on screen', closes, lines[lines.length - 1] ?? '(empty)')
  // The full tier frames the focused row (a ╭ row INSIDE the card); the
  // compact tier's ❯ caret is the under-20-rows form, under the floor.
  t.check('selection survives as the focused row\'s frame (the full tier)', lines.some(l => /│\s*╭/.test(l)), lines.find(l => /│\s*╭/.test(l)) ?? '(no framed row)')
  t.check('the cut is NAMED', /↓ \d+ more/.test(all), lines.find(l => l.includes('more')) ?? '(no counter)')
  t.check('the footer keeps its close hint', all.includes('esc close'), lines.find(l => l.includes('esc')) ?? '(no footer)')
  t.check('the banner STAYS: the floor holds the full tier (decoration sheds only under it)', all.includes('CHOOSE A MODEL'), lines.find(l => l.includes('CHOOSE A MODEL')) ?? '(no banner row)')
}

t.section(`§2 — the inline REPL keeps its input line at the floor (${VIEWPORT_FLOOR_COLS}×${VIEWPORT_FLOOR_ROWS}, the frame whole)`)
{
  const lines = renderScenario('thinking-row', VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS)
  const inputAt = lines.findIndex(l => l.trim().startsWith('❯') || l.includes('│❯'))
  t.check('a ❯ input line renders', inputAt >= 0, lines[inputAt] ?? '(no input line)')
  // The frame-shedding tier (the border rows squeezing the input line out)
  // was the 12-row form, under the floor: at the floor the frame is whole.
  t.check(
    'the frame is whole: the input line sits between its ╭ and ╰ rows',
    inputAt > 0 && (lines[inputAt - 1] ?? '').trimStart().startsWith('╭') && (lines[inputAt + 1] ?? '').trimStart().startsWith('╰'),
    `${(lines[inputAt - 1] ?? '').slice(0, 24)} / ${(lines[inputAt + 1] ?? '').slice(0, 24)}`,
  )
  t.check(
    'the footer hint keeps both its parts (the one-part shed lives under 50 columns, under the floor)',
    lines.some(l => l.includes('? for shortcuts') && l.includes('for commands + files')),
    lines.find(l => l.includes('shortcuts')) ?? '(no hint)',
  )
  const borderOnly = lines.some((l, i) => {
    const a = l.trim()
    const b = (lines[i + 1] ?? '').trim()
    return a.startsWith('╭') && b.startsWith('╰')
  })
  t.check('no border-only husk (adjacent ╭/╰ with nothing inside)', !borderOnly, 'frame either whole or shed')
}

t.section('§3 — the shared table owner degrades to records, never broken words')
{
  const React = (await import('react')).default
  const { marked } = await import('marked')
  const { MarkdownTable } = await import('../../src/components/MarkdownTable.tsx')
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const MD =
    '| ArchitecturalOwnership | VerificationStrategy | Disposition |\n' +
    '| --- | --- | --- |\n' +
    '| interaction-coverage | adversarial-refutation | living-specimen |\n' +
    '| baseline-manifest | grid-comparison | retained |\n'
  const tok = marked.lexer(MD).find(x => x.type === 'table')
  t.check('the fixture lexes to a table token', !!tok, String(tok?.type))
  const cramped = await renderToString(
    React.createElement(MarkdownTable, { token: tok as never, forceWidth: 60 }),
  )
  t.check(
    'at 60 cols the cramped table renders key/value records (no │ column borders)',
    !cramped.includes('│') && cramped.includes('ArchitecturalOwnership'),
    JSON.stringify(cramped.slice(0, 120)),
  )
  t.check(
    'long words stay INTACT in the record form (never hard-broken)',
    cramped.includes('adversarial-refutation') && cramped.includes('interaction-coverage'),
    'both long tokens whole',
  )
  const roomy = await renderToString(
    React.createElement(MarkdownTable, { token: tok as never, forceWidth: 120 }),
  )
  t.check(
    'at 120 cols the same table stays a real table (column borders present)',
    roomy.includes('│') && roomy.includes('ArchitecturalOwnership'),
    JSON.stringify(roomy.slice(0, 120)),
  )
}

t.section('§4 — the resize cycle leaves no residue (splash, real SIGWINCH)')
{
  const home = mkdtempSync(join(tmpdir(), 'contour-degrade-home-'))
  const baseEnv = {
    ...process.env,
    MERCURY_SPLASH_ONESHOT: '1',
    TERM: 'xterm-256color',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_HOME: home,
    MERCURY_HOME: home,
    MERCURY_CONFIG_DIR: home,
  }
  const run = (name: string, resizes?: Array<{ atTick: number; cols: number; rows: number }>): string[] => {
    const out = join(scratch, `${name}.json`)
    const cfg = {
      cols: 120,
      rows: 40,
      total: resizes ? 60 : 20,
      argv: ['node', 'assets/splash/mercury-splash.mjs'],
      out,
      ...(resizes ? { resizes } : {}),
    }
    const cfgPath = join(scratch, `${name}-cfg.json`)
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      env: baseEnv,
      encoding: 'utf8',
      timeout: vshotBudgetMs(240_000),
    })
    if (r.status !== 0) console.log((r.stdout ?? '').slice(-600) + (r.stderr ?? '').slice(-600))
    return gridLines(out)
  }
  const direct = run('direct')
  const cycled = run('cycled', [
    { atTick: 10, cols: 80, rows: 24 },
    { atTick: 20, cols: VIEWPORT_FLOOR_COLS, rows: VIEWPORT_FLOOR_ROWS },
    { atTick: 30, cols: 150, rows: 45 },
    { atTick: 40, cols: 120, rows: 40 },
  ])
  const VOLATILE = /Health|uncommitted|last active|·\s*\d+[smhd]\b|repos/
  const masked: string[] = []
  let mismatch = ''
  const rows = Math.max(direct.length, cycled.length)
  for (let i = 0; i < rows; i++) {
    const a = direct[i] ?? ''
    const b = cycled[i] ?? ''
    if (a !== b) {
      if (VOLATILE.test(a) || VOLATILE.test(b)) {
        masked.push(`row ${i}`)
        continue
      }
      mismatch = `row ${i}: direct=${JSON.stringify(a.slice(0, 60))} cycled=${JSON.stringify(b.slice(0, 60))}`
      break
    }
  }
  t.check('both captures painted', direct.length > 0 && cycled.length > 0, `direct=${direct.length} cycled=${cycled.length}`)
  t.check(
    `the cycle returns to the direct frame (masked: ${masked.length} volatile row(s))`,
    mismatch === '',
    mismatch || 'char-identical outside the masked strip rows',
  )
  rmSync(home, { recursive: true, force: true })
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-degradation-order')
