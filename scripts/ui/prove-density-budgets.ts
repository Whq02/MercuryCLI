#!/usr/bin/env bun
import { readManifest, readStoredGrid } from './visualBaseline.ts'

const BORDER = new Set('╭╮╰╯│─┈┃━║═▔▁'.split(''))

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const CEILINGS: Record<string, { borderPct: number; accent: number; bold: number; deepRows?: number }> = {
  'frame--60x18--dark--truecolor--full': { borderPct: 24, accent: 300, bold: 20 },
  'frame--80x24--dark--truecolor--full': { borderPct: 24, accent: 390, bold: 33 },
  'frame--97x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'frame--99x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'frame--100x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'frame--101x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'frame--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 77 },
  'frame--149x40--dark--truecolor--full': { borderPct: 27, accent: 640, bold: 75, deepRows: 13 },
  'frame--150x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'frame--151x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'frame--160x50--dark--truecolor--full': { borderPct: 27, accent: 720, bold: 102, deepRows: 15 },
  'cockpit-wide--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 120 },
  'resume-2turn--60x18--dark--truecolor--full': { borderPct: 24, accent: 300, bold: 20 },
  'resume-2turn--80x24--dark--truecolor--full': { borderPct: 24, accent: 390, bold: 33 },
  'resume-2turn--97x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'resume-2turn--99x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 50 },
  'resume-2turn--100x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'resume-2turn--101x30--dark--truecolor--full': { borderPct: 31, accent: 550, bold: 63 },
  'resume-2turn--120x40--dark--truecolor--full': { borderPct: 24, accent: 540, bold: 77 },
  'resume-2turn--149x40--dark--truecolor--full': { borderPct: 27, accent: 640, bold: 75, deepRows: 13 },
  'resume-2turn--150x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'resume-2turn--151x40--dark--truecolor--full': { borderPct: 30, accent: 660, bold: 102, deepRows: 15 },
  'resume-2turn--160x50--dark--truecolor--full': { borderPct: 27, accent: 720, bold: 102, deepRows: 15 },
  'sessions--120x40--dark--truecolor--full': { borderPct: 24, accent: 440, bold: 103 },
  'tool-cards--120x40--dark--truecolor--full': { borderPct: 24, accent: 545, bold: 110 },
  'help--120x40--dark--truecolor--full': { borderPct: 24, accent: 545, bold: 60 },
}
const DEFAULT_PER_CELL = { borderPct: 30, accentPerKcell: 200, boldPerKcell: 30 }

const manifest = readManifest()
if (!manifest) {
  console.log('FAIL  manifest present')
  process.exit(1)
}

for (const e of manifest.entries) {
  if (e.theme !== 'dark' || e.colorMode !== 'truecolor' || e.motion !== 'full') continue
  const grid = readStoredGrid(e)
  const total = e.cols * e.rows
  let border = 0
  for (const row of grid.text) for (const ch of row) if (BORDER.has(ch)) border++
  let accent = 0
  let bold = 0
  let deepRows = 0
  for (let y = 0; y < grid.rows; y++) {
    for (const sp of grid.styles[y]) {
      if (sp[2] === 'dd4444') accent += sp[1]
      if (sp[4] & 1) bold += sp[1]
    }
    const bars = (grid.text[y].match(/│/g) ?? []).length
    if (bars >= 6) deepRows++
  }
  const borderPct = Math.round((100 * border) / total)
  const c = CEILINGS[e.id] ?? {
    borderPct: DEFAULT_PER_CELL.borderPct,
    accent: Math.ceil((total / 1000) * DEFAULT_PER_CELL.accentPerKcell),
    bold: Math.ceil((total / 1000) * DEFAULT_PER_CELL.boldPerKcell),
  }
  t(`${e.id}: border ${borderPct}% ≤ ${c.borderPct}%`, borderPct <= c.borderPct)
  t(`${e.id}: accent ${accent} ≤ ${c.accent}`, accent <= c.accent)
  t(`${e.id}: bold ${bold} ≤ ${c.bold}`, bold <= c.bold)
  const deepCeil = c.deepRows ?? 0
  t(`${e.id}: ≥6-│ row density ${deepRows} ≤ ${deepCeil}`, deepRows <= deepCeil)
}

if (fail) {
  console.log('\n❌ density budgets — a ceiling broke (numbers above)')
  process.exit(1)
}
console.log('\n✅ density budgets — border/accent/bold/nesting inside the ratified ceilings')
