#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-select-mouse.ts
//  PROOF for: the core CustomSelect / SelectMulti option rows were dead
//  in a mouse-captured surface (no onClick) — every list row in permission
//  dialogs, the model picker, etc. ignored clicks. These are _c-memoized
//  renderers and mouse clicks can't be PTY-driven here, so this locks the wiring
//  by source-text (the semantics are type-checked by the strict floor):
//
//   - useSelectState exposes selectValue(v) → setValue(v) directly (NOT via the
//     async focusedValue), so a click selects the row that was clicked.
//   - select.tsx wires the option Box onClick → focusOption + selectValue +
//     onChange(option.value), the exact clicked value — mirrors keyboard Enter
//     (use-select-input.ts: selectFocusedOption + onChange(focusedValue)) — and
//     is guarded by the same disabled/disableSelection conditions.
//   - useMultiSelectState exposes toggleValue(v) (Space-equivalent add/remove,
//     fires onChange via updateSelectedValues); SelectMulti wires the row onClick
//     → toggleValue(option.value), guarded on !isDisabled. Input-type rows are
//     left non-toggling.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-select-mouse.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const cs = (f: string) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'CustomSelect', f), 'utf-8')

console.log('============================================================')
console.log(' CustomSelect mouse — option rows are clickable (HB-0190)')
console.log('============================================================')

section('single-select: selectValue + onClick wiring')
const selState = cs('use-select-state.ts')
check('useSelectState exposes selectValue in the type', /selectValue: \(value: T\) => void/.test(selState))
check('selectValue sets the value directly (not the async focusedValue)', /const selectValue = useCallback\(\s*\(next: T\) => \{\s*setValue\(next\)\s*onChange\?\.\(next\)/.test(selState))
check('selectValue is returned from the hook', /selectValue,/.test(selState))
const sel = cs('select.tsx')
check('the option Box has an onClick handler', /onClick=\{\s*clickable\s*\?\s*\(\) => \{/.test(sel))
check('onClick selects the EXACT clicked option.value via onChange (mirrors Enter)', /state\.selectValue\(optionValueOf\(option\)\)/.test(sel) && /onChange\?\.\(next\)/.test(selState))
check('onClick focuses the clicked row', /state\.focusValue\(optionValueOf\(option\)\)\s*state\.selectValue\(optionValueOf\(option\)\)/.test(sel))
check('onClick is guarded by the same disabled/disableSelection as Enter', /const clickable =\s*layout === 'expanded' && disableSelection !== true && !option\.disabled/.test(sel))

section('multi-select: toggleValue + onClick wiring')
const multiState = cs('use-multi-select-state.ts')
check('useMultiSelectState exposes toggleValue in the type', /toggleValue: \(value: T\) => void/.test(multiState))
check('toggleValue add/removes against the live selection ref (fires onChange)', /const toggleValue = useCallback\(\s*\(value: T\): void => \{\s*const current = selectedValuesRef\.current[\s\S]{0,240}setSelectedValues\(next\)\s*onChange\?\.\(next\)/.test(multiState))
check('toggleValue is returned from the hook', /toggleValue,/.test(multiState))
const multi = cs('SelectMulti.tsx')
check('the SelectMulti option row onClick toggles the clicked value', /onClick=\{\s*isDisabled\s*\?\s*undefined\s*:\s*\(\) => \{\s*state\.toggleValue\(optionValueOf\(option\)\)/.test(multi))

section('regression guard: keyboard Enter path is unchanged')
const input = cs('use-select-input.ts')
check('Enter still selects the focused option + onChange(focusedValue)', /state\.selectFocusedOption\(\)/.test(input) && /const selectFocusedOption = useCallback\(\(\) => \{\s*if \(focusedValue === undefined\) return\s*setValue\(focusedValue\)\s*onChange\?\.\(focusedValue\)/.test(selState))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SELECT-MOUSE PROOFS PASS')
else console.log(`❌ ${failures} SELECT-MOUSE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
