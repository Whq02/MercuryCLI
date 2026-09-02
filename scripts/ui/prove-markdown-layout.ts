#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-markdown-layout.ts
//  PROOF for the markdown renderer LAYOUT fixes. (Historical note: this proof
//  was written source-text-style because utils/markdown.ts was unloadable
//  under bun-run behind the voice feature() macro — that macro is absent;
//  the native-build program and the module loads fine now (
//  prove-markdown-incremental drives it directly); the source-text checks
//  below still hold and are kept as-is.)
//
//   (loose lists lose markers): loose-list items wrap content in a
//     `paragraph` (tight lists use bare `text`); the marker was only emitted in
//     the text case → loose lists dropped ALL bullets/numbers. Premise verified:
//     marked emits paragraph children for loose items, text for tight.
//   (table width budgeting): applyMarkdown's 'table' case sized columns
//     to full content with no budget → wide tables overflowed and were silently
//     right-chopped by the caller (PreviewBox sliceAnsi). Now budgeted to a width
//     (terminal, or the preview box) with ANSI-safe per-cell '…' truncation so
//     every row (incl. the border) clips at the same column.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-markdown-layout.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'
import sliceAnsi from '../../src/utils/sliceAnsi.js'
import { stringWidth } from '../../src/ink/stringWidth.js'
import stripAnsi from 'strip-ansi'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const md = readFileSync(join(ROOT, 'src', 'utils', 'markdown.ts'), 'utf-8')
const preview = readFileSync(
  join(ROOT, 'src', 'components', 'permissions', 'AskUserQuestionPermissionRequest', 'PreviewBox.tsx'),
  'utf-8',
)

console.log('============================================================')
console.log(' markdown layout — loose lists (HB-0203) + table width (HB-0167)')
console.log('============================================================')

section('HB-0203: marked token-structure premise + source wiring')
const itemTypes = (src: string) =>
  (marked.lexer(src).find(t => t.type === 'list') as { items: { tokens?: { type: string }[] }[] })
    .items.map(it => (it.tokens ?? []).map(t => t.type).join(','))
check('tight list item → bare `text` child', itemTypes('- one\n- two').every(t => t === 'text'))
check('loose list item → `paragraph` child', itemTypes('- one\n\n- two').every(t => t.startsWith('paragraph')))
check('ordered loose item → `paragraph` child', itemTypes('1. a\n\n2. b').every(t => t.startsWith('paragraph')))
check(
  "the paragraph case now emits the marker when parent is a list_item",
  /parent\?\.type === 'list_item'/.test(md) && /orderedListNumber === null\s*\n?\s*\?\s*'-'/.test(md),
)
check(
  'the marker is emitted for the FIRST block only (idx 0 carries parent+number)',
  /idx === 0 \? orderedListNumber : null, idx === 0 \? token : null/.test(md),
)

section('HB-0167: table width budgeting source wiring')
check('applyMarkdown accepts a maxWidth (defaults to terminal width / Infinity)', /maxWidth: number = process\.stdout\.columns \?\? Number\.POSITIVE_INFINITY/.test(md))
check('formatToken threads a widthBudget param', /widthBudget: number = Number\.POSITIVE_INFINITY/.test(md))
check('the table case shrinks the widest column to fit (floor 3)', /while \(tableW > widthBudget\)/.test(md) && /<= 3\) break/.test(md))
check('over-width cells are ANSI-safe truncated with an ellipsis', /sliceAnsi\(content, 0, Math\.max\(1, width - 1\)\) \+ '…'/.test(md))
check('PreviewBox passes its inner box width to applyMarkdown', /applyMarkdown\(content, theme, highlight, effectiveMaxWidth - 4\)/.test(preview))

section('HB-0167: budgeting algorithm behaviour (real sliceAnsi/stringWidth)')
// Mirror of the shipped table render (columnWidths → shrink-widest → renderCell).
function renderTable(header: string[], rows: string[][], widthBudget: number): string {
  const columnWidths = header.map((h, i) => {
    let m = stringWidth(stripAnsi(h))
    for (const r of rows) m = Math.max(m, stringWidth(stripAnsi(r[i] ?? '')))
    return Math.max(m, 3)
  })
  const overhead = columnWidths.length * 3 + 1
  let tableW = columnWidths.reduce((a, w) => a + w, 0) + overhead
  while (tableW > widthBudget) {
    const wi = columnWidths.indexOf(Math.max(...columnWidths))
    if ((columnWidths[wi] ?? 0) <= 3) break
    columnWidths[wi]!--
    tableW--
  }
  const rc = (cell: string, w: number): string => {
    let c = cell
    let dw = stringWidth(stripAnsi(c))
    if (dw > w) { c = sliceAnsi(c, 0, Math.max(1, w - 1)) + '…'; dw = stringWidth(stripAnsi(c)) }
    return c + ' '.repeat(Math.max(0, w - dw))
  }
  let out = '| '
  header.forEach((h, i) => (out += rc(h, columnWidths[i]!) + ' | '))
  out = out.trimEnd() + '\n|'
  columnWidths.forEach(w => (out += '-'.repeat(w + 2) + '|'))
  out += '\n'
  rows.forEach(r => { out += '| '; r.forEach((c, i) => (out += rc(c, columnWidths[i]!) + ' | ')); out = out.trimEnd() + '\n' })
  return out
}
const ESC = '\x1b[1m', RST = '\x1b[0m'
const header = ['Column One Header', `${ESC}Bold Col Two${RST}`, 'Third Column Here']
const rows = [['a very long value in column one', `colored ${ESC}bold${RST} value`, 'another long cell value']]
const widthsOf = (t: string) => t.split('\n').filter(Boolean).map(l => stringWidth(stripAnsi(l)))

const wide = renderTable(header, rows, 200)
check('a table that already fits is left unbudgeted (no ellipsis)', !wide.includes('…'))
check('wide: all rows are equal width', new Set(widthsOf(wide)).size === 1)

const narrow = renderTable(header, rows, 40)
const nw = widthsOf(narrow)
check('narrow: all rows (incl. the border) are equal width (aligned)', new Set(nw).size === 1, `widths=${[...new Set(nw)].join(',')}`)
check('narrow: the table fits the 40-col budget', nw.every(w => w <= 40))
check('narrow: truncation is VISIBLE (ellipsis), not a silent chop', narrow.includes('…'))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MARKDOWN-LAYOUT PROOFS PASS')
else console.log(`❌ ${failures} MARKDOWN-LAYOUT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
