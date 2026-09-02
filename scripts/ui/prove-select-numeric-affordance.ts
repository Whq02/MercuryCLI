#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-select-numeric-affordance.ts
//  PROOF for: numeric quick-select resolves on a SINGLE keystroke (the
//  ink useInput contract fires per-character), so typing 1 then 2 to reach
//  option 12 fires twice — the first selects option 1 and returns → options 10+
//  are UNREACHABLE by number entry, yet the render padded index labels to 2
//  digits and showed "10.", "11.", … (a visible numbered affordance that can
//  never be hit). Fix: render-only suppression — labels render the number for
//  ordinals 1-9 and an EQUAL-WIDTH BLANK for 10+ (never drop the element — that
//  would collapse the column + left-shift rows 10+). The numeric INPUT handlers
//  are LEFT AS-IS (a genuine paste of "12" as one InputEvent legitimately
//  selects option 12; only the false "type this number" promise is removed).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-select-numeric-affordance.ts
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
const r = (f: string) => readFileSync(join(root, 'src', 'components', 'CustomSelect', f), 'utf-8')
const select = r('select.tsx')
const selectMulti = r('SelectMulti.tsx')
const inputOption = r('select-input-option.tsx')
const useSel = r('use-select-input.ts')

console.log('============================================================')
console.log(' Select numeric affordance: blank 10+ (HB-0196)')
console.log('============================================================')

section('source: all 5 label sites suppress the number for ordinals 10+ (equal-width blank)')
check('select.tsx indexPrefix guards <= 9 then pads to the reserved width', /const raw = index1 <= 9 \? `\$\{index1\}\.` : ''\s*return raw\.padEnd\(reservedWidth\)/.test(select))
check('select.tsx text rows prefix through the ONE rowPrefix helper (numeric path = indexPrefix)', /: indexPrefix\(index1, reservedWidth\)/.test(select) && /rowPrefix\(option, option\.index \+ 1, textRowReserved\)/.test(select))
check('select.tsx carries exactly ONE numeric guard site (the helper; no per-layout copies)', (select.match(/<= 9/g) ?? []).length === 1)
check('SelectMulti.tsx guards <= 9 and pads to digitCount + 1', /\(option\.index \+ 1 <= 9 \? `\$\{option\.index \+ 1\}\.` : ''\)\.padEnd\(\s*digitCount \+ 1,?\s*\)/.test(selectMulti))
check('select-input-option.tsx guards <= 9 on the numeric prefix', /: \(index <= 9 \? `\$\{index\}\.` : ''\)\.padEnd\(reservedIndexWidth \+ 2\)/.test(inputOption))
check('no bare `${i}.`.padEnd index label remains unguarded in select.tsx', !/`\$\{[a-zA-Z0-9_.+ ]+\}\.`\.padEnd/.test(select))

section('slot-safety: maxIndexWidth (the cache slot) is UNCHANGED — only the per-row ordinal is conditional')
// the pad WIDTH stays the full 2-digit column so the blanks align with the 2-digit pad
check('select.tsx still pads numeric AND declared-ordinal prefixes to the reserved width (width preserved)', /return raw\.padEnd\(reservedWidth\)/.test(select) && /option\.indexLabel\.padEnd\(Math\.max\(reservedWidth, option\.indexLabel\.length \+ 1\)\)/.test(select))
check('select-input-option.tsx still pads the prefix to reservedIndexWidth + 2 (width preserved)', /option\.indexLabel\.padEnd\(\s*Math\.max\(reservedIndexWidth \+ 2, option\.indexLabel\.length \+ 1\),?\s*\)/.test(inputOption) && /\.padEnd\(reservedIndexWidth \+ 2\)/.test(inputOption))

section('input handlers LEFT AS-IS: a genuine paste of a multi-digit number still selects')
check('use-select-input.ts still resolves a numeric InputEvent (the paste path is untouched)', /\/\^\\d\+\$\/\.test\(digits\)/.test(useSel) && /parseInt\(digits, 10\)/.test(useSel))

section('behaviour: 1-9 unchanged (byte-identical), 10+ suppressed but EQUAL WIDTH (aligned)')
// verbatim mirror of the per-site expression `(n <= 9 ? `${n}.` : '').padEnd(W)`
const cell = (n: number, w: number): string => (n <= 9 ? `${n}.` : '').padEnd(w)
const W = 4 // 2-digit column ("12." → width 3) padded
let common = 0
for (let n = 1; n <= 9; n++) {
  if (cell(n, W) === `${n}.`.padEnd(W)) common++ // identical to the OLD render for 1-9
}
check('ordinals 1-9 render byte-identically to the old `${n}.`.padEnd(W)', common === 9)
let blanksAligned = 0
for (let n = 10; n <= 14; n++) {
  if (cell(n, W).length === W && cell(n, W).trim() === '') blanksAligned++ // blank, full width
}
check('ordinals 10+ render an EQUAL-WIDTH BLANK (no number, no column collapse)', blanksAligned === 5)
check('the blank (10+) and the number (≤9) occupy the SAME width (rows stay column-aligned)', cell(10, W).length === cell(9, W).length)
check('no "10."/"11."/"12." text is ever emitted for ordinals 10+', !/\d/.test(cell(10, W) + cell(11, W) + cell(12, W)))

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0196 — dead numbered affordance suppressed for 10+ (aligned, 1-9 unchanged)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0196 — ${failures} check(s) failed`)
  process.exit(1)
}
