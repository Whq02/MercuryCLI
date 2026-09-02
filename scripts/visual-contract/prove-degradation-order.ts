#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-degradation-order.ts — the CN-14 degradation-order
//  laws, locked at each family's worst historical offender (
//  CN-15/CN-16).
//
//  §1 MODAL family (the 45×12 model picker — the worst offender: the card
//     would otherwise paint past the viewport): the COMPACT tier closes inside the
//     viewport — bottom border present, the ❯ caret carries selection, the
//     cut is NAMED (`↓ N more`), the footer keeps its esc close hint, and
//     the banner (decoration) is absent.
//
//  §2 INLINE-REPL family (the 45×12 composer — the worst offender: the
//     border rows squeezed the input line out, leaving a border-only husk):
//     a bare ❯ input line renders, the footer hint sheds to exactly
//     `? for shortcuts`, and no adjacent ╭/╰ border-only pair exists.
//
//  §3 TABLE family (MarkdownTable, the shared transcript-table owner): a
//     table cramped past its minimum word widths degrades to key/value
//     records — long header words stay INTACT (words never break); a table
//     that fits at 100 cols stays horizontal.
//
//  §4 RESIZE-CYCLE return (the splash — sendless, deterministic): driving
//     120×40 → 80×24 → 45×12 → 150×45 → 120×40 through real SIGWINCH ends
//     char-identical (volatile strip rows masked EXPLICITLY) to a direct
//     120×40 boot — reflow leaves no residue.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

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
    ['run', 'scripts/ui/render-tui.ts', '--scenario', name, '--cols', String(cols), '--rows', String(rows), '--out', join(scratch, `${name}-${cols}.png`)],
    { encoding: 'utf8', timeout: vshotBudgetMs(240_000) },
  )
  if (r.status !== 0) {
    console.log((r.stdout ?? '').slice(-800) + (r.stderr ?? '').slice(-800))
    return []
  }
  return gridLines(`/tmp/grid-${cols}.json`)
}

t.section('§1 — the modal family closes inside a 45×12 viewport (compact tier)')
{
  const lines = renderScenario('model-picker-home', 45, 12)
  const all = lines.join('\n')
  const closes = lines.some(l => l.trimStart().startsWith('╰'))
  // A hosted red here was undiagnosable from the one-line detail (gate run
  // 30677930073) — on any failure, print the WHOLE grid.
  if (!closes) lines.forEach((l, i) => console.log(`      grid[${String(i).padStart(2, '0')}] ${JSON.stringify(l)}`))
  t.check('the card CLOSES: a bottom border row is on screen', closes, lines[lines.length - 1] ?? '(empty)')
  t.check('selection survives as the ❯ caret (border simplified away)', all.includes('❯ '), lines.find(l => l.includes('❯')) ?? '(no caret)')
  t.check('the cut is NAMED', /↓ \d+ more/.test(all), lines.find(l => l.includes('more')) ?? '(no counter)')
  t.check('the footer keeps its close hint', all.includes('esc close'), lines.find(l => l.includes('esc')) ?? '(no footer)')
  t.check('the banner (decoration) is gone', !all.includes('CHOOSE A MODEL'), 'no banner row')
}

t.section('§2 — the inline REPL keeps its input line at 45×12 (frame sheds)')
{
  const lines = renderScenario('thinking-row', 45, 12)
  const all = lines.join('\n')
  t.check('a ❯ input line renders', lines.some(l => l.trim().startsWith('❯') || l.includes('│❯')), lines.find(l => l.includes('❯')) ?? '(no input line)')
  t.check(
    'the footer hint sheds to exactly `? for shortcuts`',
    lines.some(l => l.trim() === '? for shortcuts'),
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
    { atTick: 20, cols: 45, rows: 12 },
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
