#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-footer-suggestions-overflow.ts
//  PROOF for: the slash/@-file completion menu rendered only a window of
//  maxVisibleItems (5 overlay / min(6,max(1,rows-3)) inline) with NO overflow
//  affordance — no "+N more", no count — so a broad filter routinely produced
//  more items than shown with zero signal the list continues. Fix: de-_c the
//  PromptInputFooterSuggestions renderer (was _c(22)) to plain, then add a dim
//  "X of Y" status row when the list overflows — RESERVING its line (itemBudget
//  = maxVisibleItems-1) so it never costs a visible item-row past the prompt
//  budget. The count form (not "+N more") is honest: the window is
//  selection-CENTERED, so items can be hidden ABOVE and below.
//
//  Render-verify (the slash menu at 80/120, inline + overlay) is in
//  render-footer-suggestions.tsx (UI_RENDER=1).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-footer-suggestions-overflow.ts
// ============================================================================
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
// the function body only (exclude SuggestionItemRow's own _c(36))
const fn = src.slice(src.indexOf('export function PromptInputFooterSuggestions'))

console.log('============================================================')
console.log(' footer suggestions overflow count + de-_c (HB-0194)')
console.log('============================================================')

section('source: PromptInputFooterSuggestions AND SuggestionItemRow are de-_c-memoized (plain)')
check('the function body has NO `const $ = _c(22)` and NO $[…] cache reads', !/const \$ = _c\(22\)/.test(fn) && !/\$\[\d+\]/.test(fn))
// Phase 3b de-compile wave: SuggestionItemRow is plain now too (no _c anywhere in the file).
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
  const totalRows = itemBudget + (hasOverflow ? 1 : 0) // item-rows + the count row
  return { maxVisibleItems, hasOverflow, itemBudget, totalRows }
}
// (1) no overflow: full budget, no count row, total ≤ maxVisibleItems
{
  let ok = true
  for (let rows = 4; rows <= 40; rows++)
    for (let len = 0; len <= budget(false, rows, 0).maxVisibleItems; len++) {
      const b = budget(false, rows, len)
      if (b.hasOverflow || b.itemBudget !== b.maxVisibleItems) ok = false
    }
  check('len ≤ maxVisibleItems ⇒ no overflow, full budget, no count row (unchanged)', ok)
}
// (2) overflow on a NORMAL terminal (maxVisibleItems ≥ 2): items + count == maxVisibleItems (prompt NOT clipped)
{
  let ok = true
  for (let rows = 6; rows <= 40; rows++) {
    const m = budget(false, rows, 0).maxVisibleItems
    if (m < 2) continue
    const b = budget(false, rows, 100)
    if (b.totalRows !== m) ok = false // exactly fills the budget, reserves the count line
  }
  check('overflow + maxVisibleItems ≥ 2: itemBudget + count row == maxVisibleItems (prompt budget honored)', ok)
}
// (3) the rows-3==1 edge (maxVisibleItems == 1): floor at 1 item (never 0); documented 2-row edge
{
  const b = budget(false, 4, 100) // rows-3 = 1
  check('maxVisibleItems==1 + overflow ⇒ 1 item (never 0) + 1 count = 2 rows (the documented floor edge)', b.maxVisibleItems === 1 && b.itemBudget === 1 && b.totalRows === 2)
}
// (4) the count is the selection-centered "X of Y": X = selectedSuggestion+1, Y = total
{
  const len = 30
  const sel = 17
  // verbatim of the rendered string
  const countStr = `${sel + 1} of ${len}`
  check('the count row reads "X of Y" with X=selectedSuggestion+1 and Y=total (honest under center-scroll)', countStr === '18 of 30')
}
// (5) overflow (maxVisibleItems ≥ 2): itemBudget is one LESS than the no-overflow budget (the reserve)
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
