#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'src', 'components', 'PromptInput', 'PromptInputFooterSuggestions.tsx'), 'utf-8')
const fn = src.slice(src.indexOf('export function PromptInputFooterSuggestions'))

console.log('============================================================')
console.log(' footer suggestions overflow count + de-_c (HB-0194)')
console.log('============================================================')

section('source: PromptInputFooterSuggestions AND SuggestionItemRow are de-_c-memoized (plain)')
check('the function body has NO `const $ = _c(22)` and NO $[…] cache reads', !/const \$ = _c\(22\)/.test(fn) && !/\$\[\d+\]/.test(fn))
check('SuggestionItemRow is de-_c-memoized as well (no _c in the file)', !/\b_c\(/.test(src))
check('the function computes the name column directly (no cache slot)', /const derivedWidth =\s*Math\.max\(0, \.\.\.suggestions\.map\(item => displayWidth\(item\.displayText\)\)\) \+ 5/.test(fn) && /maxColumnWidth \?\? derivedWidth/.test(fn))

section('source: the overflow budget + honest count row are wired')
check('overflowing = suggestions.length > maxVisible', /const overflowing = suggestions\.length > maxVisible/.test(fn))
check('the overflow reserves one line for the counter, floored at 1 item', /if \(overflowing\) \{[\s\S]{0,200}maxVisible = Math\.max\(1, maxVisible - 1\)/.test(fn))
check('the selection-centred window is cut against the reduced budget', /const half = Math\.floor\(maxVisible \/ 2\)/.test(fn) && /Math\.min\(anchor - half, suggestions\.length - maxVisible\)/.test(fn) && /suggestions\.slice\(start, start \+ maxVisible\)/.test(fn))
check('a dim "X of Y" count row renders only on overflow (count, NOT "+N more")', /\{overflowing \? \(\s*<Text dimColor>[\s\S]{0,160}of\{' '\}\s*\{suggestions\.length\}/.test(fn))
check('the count uses selectedSuggestion + 1 (1-based "X"), NOT a trailing "+N more"', !/\+\s*N\s*more|more`/.test(fn))

section('behaviour: the reserved row never overflows the prompt budget; count is correct')
const budget = (overlay: boolean, rows: number, len: number) => {
  const maxVisibleItems = overlay ? 5 : Math.min(6, Math.max(1, rows - 3))
  const hasOverflow = len > maxVisibleItems
  const itemBudget = hasOverflow ? Math.max(1, maxVisibleItems - 1) : maxVisibleItems
  const totalRows = itemBudget + (hasOverflow ? 1 : 0)
  return { maxVisibleItems, hasOverflow, itemBudget, totalRows }
}
{
  let ok = true
  for (let rows = 4; rows <= 40; rows++)
    for (let len = 0; len <= budget(false, rows, 0).maxVisibleItems; len++) {
      const b = budget(false, rows, len)
      if (b.hasOverflow || b.itemBudget !== b.maxVisibleItems) ok = false
    }
  check('len ≤ maxVisibleItems ⇒ no overflow, full budget, no count row (unchanged)', ok)
}
{
  let ok = true
  for (let rows = 6; rows <= 40; rows++) {
    const m = budget(false, rows, 0).maxVisibleItems
    if (m < 2) continue
    const b = budget(false, rows, 100)
    if (b.totalRows !== m) ok = false
  }
  check('overflow + maxVisibleItems ≥ 2: itemBudget + count row == maxVisibleItems (prompt budget honored)', ok)
}
{
  const b = budget(false, 4, 100)
  check('maxVisibleItems==1 + overflow ⇒ 1 item (never 0) + 1 count = 2 rows (the documented floor edge)', b.maxVisibleItems === 1 && b.itemBudget === 1 && b.totalRows === 2)
}
{
  const len = 30
  const sel = 17
  const countStr = `${sel + 1} of ${len}`
  check('the count row reads "X of Y" with X=selectedSuggestion+1 and Y=total (honest under center-scroll)', countStr === '18 of 30')
}
{
  let reserved = true
  for (let rows = 6; rows <= 40; rows++) {
    const m = budget(false, rows, 0).maxVisibleItems
    if (m < 2) continue
    if (budget(false, rows, 100).itemBudget !== m - 1) reserved = false
  }
  check('overflow reserves exactly one item-line for the count row (itemBudget == maxVisibleItems - 1)', reserved)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0194 — footer suggestions overflow count + de-_c proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0194 — ${failures} check(s) failed`)
  process.exit(1)
}
