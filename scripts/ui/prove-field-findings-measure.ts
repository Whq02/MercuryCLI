#!/usr/bin/env bun
import { join } from 'node:path'


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 RHP-1 — the multi-line measure wraps like the compositor')
{
  const measureText = (await import('../../src/screen/renderer/measure-text.ts')).default
  const wrapText = (await import('../../src/screen/renderer/wrap-text.ts')).default
  const token = 'C:/Users/OPERATOR/AppData/Local/merc/aaaa'
  const line = Array(6).fill(token).join(' ')
  const text = `first paragraph\n\n${line}`
  const ceilHeight = measureText(text, 80).height
  const wrappedLines = text.split('\n').map(l => wrapText(l, 80, 'wrap'))
  const paintedRows = wrappedLines.join('\n').split('\n').length
  check('the disease at the primitives: the ceiling reserves fewer rows than the wrap paints', token.length === 41 && ceilHeight === 6 && paintedRows === 8, `ceil=${ceilHeight} painted=${paintedRows} — the primitives measureText in src/screen/renderer/measure-text.ts and wrapText in src/screen/renderer/wrap-text.ts no longer give 6 measured and 8 painted rows for this text; restore the one that moved`)
  check('wrapped-then-measured equals the painted row count (the law the measure now follows)', measureText(wrappedLines.join('\n'), 80).height === paintedRows, `measured ${measureText(wrappedLines.join('\n'), 80).height} rows, painted ${paintedRows} — measureText in src/screen/renderer/measure-text.ts must count the rows wrapText in src/screen/renderer/wrap-text.ts paints`)
}

process.exit(failures === 0 ? 0 : 1)
