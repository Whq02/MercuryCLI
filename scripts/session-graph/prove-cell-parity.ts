#!/usr/bin/env bun

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
      if (row[i + 1] && row[i + 1]!.c === '') wideOk++
      else misallocated++
    }
  }
  t.check(
    'every wide glyph owns exactly its allocated cells (no width drift)',
    misallocated === 0,
    `${misallocated} misallocated wide cells (${wideOk} correct)`,
  )
  t.check('the width law ran on real wide glyphs (the CJK seed is present)', wideOk > 0, `${wideOk} wide cells`)
}

t.section('§3 — the glyph law: no emoji in the terminal grid')
{
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
