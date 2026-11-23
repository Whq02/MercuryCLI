#!/usr/bin/env bun
import { join } from 'node:path'
import { marked } from 'marked'
import sliceAnsi from '../../src/platform/text/sliceAnsi.js'
import { stringWidth } from '../../src/screen/renderer/stringWidth.js'
import stripAnsi from 'strip-ansi'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const LEXER_HINT = 'the installed marked package no longer returns this token structure for the list, so check its version and whatever reads list item tokens'
const TABLE_HINT = 'renderTable in this file or the sliceAnsi and stringWidth helpers it calls (src/platform/text/sliceAnsi.ts, src/screen/renderer/stringWidth.ts) no longer budget the table columns as asserted'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' markdown layout — loose lists (HB-0203) + table width (HB-0167)')
console.log('============================================================')

section('HB-0203: marked token-structure premise + source wiring')
const itemTypes = (src: string) =>
  (marked.lexer(src).find(t => t.type === 'list') as { items: { tokens?: { type: string }[] }[] })
    .items.map(it => (it.tokens ?? []).map(t => t.type).join(','))
check('tight list item → bare `text` child', itemTypes('- one\n- two').every(t => t === 'text'), '', LEXER_HINT)
check('loose list item → `paragraph` child', itemTypes('- one\n\n- two').every(t => t.startsWith('paragraph')), '', LEXER_HINT)
check('ordered loose item → `paragraph` child', itemTypes('1. a\n\n2. b').every(t => t.startsWith('paragraph')), '', LEXER_HINT)


section('HB-0167: budgeting algorithm behaviour (real sliceAnsi/stringWidth)')
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
check('a table that already fits is left unbudgeted (no ellipsis)', !wide.includes('…'), '', TABLE_HINT)
check('wide: all rows are equal width', new Set(widthsOf(wide)).size === 1, '', TABLE_HINT)

const narrow = renderTable(header, rows, 40)
const nw = widthsOf(narrow)
check('narrow: all rows (incl. the border) are equal width (aligned)', new Set(nw).size === 1, `widths=${[...new Set(nw)].join(',')}`, TABLE_HINT)
check('narrow: the table fits the 40-col budget', nw.every(w => w <= 40), '', TABLE_HINT)
check('narrow: truncation is VISIBLE (ellipsis), not a silent chop', narrow.includes('…'), '', TABLE_HINT)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MARKDOWN-LAYOUT PROOFS PASS')
else console.log(`❌ ${failures} MARKDOWN-LAYOUT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
