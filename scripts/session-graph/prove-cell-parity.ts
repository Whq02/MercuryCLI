#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-cell-parity.ts — the M9 normalized
//  terminal-cell parity model.
//
//  Cross-OS parity compares a NORMALIZED cell model — character/grapheme,
//  width, semantic colour class, emphasis — never font-rasterized pixels.
//  THIS prover owns the model and its same-host laws; the OS legs ride the
//  windows-ui workflow (the campaign's pkg-constellation-crew-wt-ps7
//  scenario) against the same needles:
//
//    §1 determinism    — two independent renders of the crew board yield the
//                        IDENTICAL normalized model (live numerals masked —
//                        parity is glyph/width/colour class, not clock time)
//    §2 width honesty  — every cell's character measures its allocated cells
//                        through Mercury's own width owner (no grapheme
//                        drift between what was measured and what painted)
//    §3 glyph law      — no emoji in the terminal grid (the design-system
//                        law; box/geometric chrome glyphs are width-1)
//    §4 needle law     — the campaign needles are split-safe pure ASCII and
//                        present in the settled grid (the capture
//                        law's local leg)
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { stringWidth } from '../../src/ink/stringWidth.ts'

const t = checker()

interface GridCell {
  c: string
  fg: string
  bg: string
  bold: boolean
  rev: boolean
}
interface Grid {
  cols: number
  rows: number
  grid: GridCell[][]
}

// Per-invocation scratch grid paths (final audit): the fixed /tmp grid path
// is shared by every pty-lane suite the gate runs concurrently — a clobber
// between this prover's two renders would compare a foreign grid. The byte
// law demands hermetic reads.
const gridScratch = realpathSync(mkdtempSync(join(tmpdir(), 'cell-parity-')))
let renderSeq = 0
function render(cols: number): Grid {
  const gridPath = join(gridScratch, `grid-${cols}-${++renderSeq}.json`)
  execFileSync(
    'bun',
    ['run', 'scripts/ui/render-tui.ts', '--scenario', 'prompts-panel', '--cols', String(cols), '--grid', gridPath],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 },
  )
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
}

/** THE normalized cell model: char (live numerals masked) · width · colour
 *  class · emphasis. Identical input ⇒ identical model on every OS. */
function normalizedModel(g: Grid): string {
  return g.grid
    .map(row =>
      row
        .map(cell => {
          const ch = /\d/.test(cell.c) ? '#' : cell.c
          return `${ch}|${stringWidth(cell.c)}|${cell.fg}|${cell.bg}|${cell.bold ? 'b' : '-'}${cell.rev ? 'r' : '-'}`
        })
        .join(','),
    )
    .join('\n')
}

t.section('§1 — determinism: two renders, one normalized model')
const first = render(120)
const second = render(120)
{
  const a = normalizedModel(first)
  const b = normalizedModel(second)
  t.check(
    'two independent renders normalize to the IDENTICAL cell model',
    a === b,
    a === b ? 'identical' : `models diverge (${a.length} vs ${b.length} chars)`,
  )
}

t.section('§2 — width honesty through the ONE width owner')
{
  let misallocated = 0
  let wideOk = 0
  for (const row of first.grid) {
    for (let i = 0; i < row.length; i++) {
      const w = stringWidth(row[i]!.c)
      if (w <= 1) continue
      // A wide glyph must own its second cell — the grid encodes the owned
      // filler as an EMPTY cell (''), never a space (a space would be a
      // separate width-1 glyph and the columns would drift).
      if (row[i + 1] && row[i + 1]!.c === '') wideOk++
      else misallocated++
    }
  }
  t.check(
    'every wide glyph owns exactly its allocated cells (no width drift)',
    misallocated === 0,
    `${misallocated} misallocated wide cells (${wideOk} correct)`,
  )
  // The law must EXECUTE: the scenario seeds a CJK-titled thread precisely
  // so wide glyphs exist here — zero wide cells means the input vanished and
  // the check above passed while policing nothing (final audit).
  t.check('the width law ran on real wide glyphs (the CJK seed is present)', wideOk > 0, `${wideOk} wide cells`)
}

t.section('§3 — the glyph law: no emoji in the terminal grid')
{
  // The SMP emoji planes + the emoji-presentation selector. Deliberately NOT
  // the BMP dingbat/symbol ranges — the design system's chrome legitimately
  // uses geometric ornaments there (❯ prompt, ⚑ warn flag), all width-1
  // text-presentation glyphs; the banned class is colored emoji.
  const emoji = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u
  let found = ''
  for (const row of first.grid) {
    for (const cell of row) {
      if (emoji.test(cell.c)) {
        found = cell.c
        break
      }
    }
    if (found) break
  }
  t.check('the grid carries no emoji (chrome glyphs are geometric, width-1)', found === '', found)
}

t.section('§4 — the split-safe needle law (the campaign legs share these)')
{
  const text = first.grid.map(row => row.map(c => c.c).join('')).join('\n')
  // The panel's own chrome (the WORK board's needles left with
  // it).
  for (const needle of ['PROMPTS', 'SAVED PROMPTS', 'esc close']) {
    const pureAscii = [...needle].every(ch => ch >= ' ' && ch <= '~')
    t.check(
      `'${needle}' is pure ASCII and present in the settled grid`,
      pureAscii && text.includes(needle),
      pureAscii ? 'present check failed' : 'NOT pure ascii',
    )
  }
}

t.finish('prove-cell-parity')
