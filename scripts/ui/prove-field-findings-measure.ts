#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-measure.ts
// TASK-017 SUPPLEMENT 3 fixes — the text measure. A pure
//  drive of the primitives plus the source seam in the layout engine.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-measure.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · RHP-1: layout reserves the rows the compositor paints ──────────────
// Finding RHP-1 (important): multi-line <Text> under a carried constraint was
// measured as ceil(cells / width) per source line while the compositor paints
// greedy word wrap per source line — six 41-cell tokens in 80 columns reserve
// 6 rows and paint 8, and the next row overpainted the tail. The measure now
// wraps each line exactly as compose does before counting.
console.log('§1 RHP-1 — the multi-line measure wraps like the compositor')
{
  const measureText = (await import('../../src/ink/measure-text.ts')).default
  const wrapText = (await import('../../src/ink/wrap-text.ts')).default
  const token = 'C:/Users/OPERATOR/AppData/Local/merc/aaaa'
  const line = Array(6).fill(token).join(' ')
  const text = `first paragraph\n\n${line}`
  const ceilHeight = measureText(text, 80).height
  const wrappedLines = text.split('\n').map(l => wrapText(l, 80, 'wrap'))
  const paintedRows = wrappedLines.join('\n').split('\n').length
  check('the disease at the primitives: the ceiling reserves fewer rows than the wrap paints', token.length === 41 && ceilHeight === 6 && paintedRows === 8, `ceil=${ceilHeight} painted=${paintedRows}`)
  check('wrapped-then-measured equals the painted row count (the law the measure now follows)', measureText(wrappedLines.join('\n'), 80).height === paintedRows)
  const dom = read('src/ink/dom.ts')
  const branch = dom.slice(dom.indexOf("if (text.includes('\\n')) {"), dom.indexOf('const wrapped = wrapText(text, width, node.style.textWrap'))
  check('the carried-constraint branch wraps every source line before measuring', branch.includes('for (let i = 0; i < lines.length; i++) lines[i] = wrapText(lines[i]!, width, textWrap)') && branch.includes("return measureText(lines.join('\\n'), width)"))
  check('POISON: the unwrapped multi-line measure is gone from that branch', !branch.includes('return measureText(text, width)'))
  check('the width-less probe branch stands (a pre-wrapped string is never re-wrapped at a probe width)', branch.includes('return measureText(text, Math.max(width, natural.width))'))
}
// NEEDS-REAL-BOX: Windows Terminal at 80 columns, a reply whose second
// paragraph is six space-separated 41-character tokens — six rows painted
// whole, the next block starts below them; the same text at 120 columns.

process.exit(failures === 0 ? 0 : 1)
