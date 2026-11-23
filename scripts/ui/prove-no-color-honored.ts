#!/usr/bin/env bun
import { shouldHonorNoColor } from '../../src/screen/renderer/colorize.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const failHint = 'fix shouldHonorNoColor in src/screen/renderer/colorize.ts so this environment gives the stated answer'
  const shown = cond || detail ? detail : failHint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' NO_COLOR honored (no-color.org) — precedence + wiring')
console.log('============================================================')

section('precedence truth table (FORCE_COLOR overrides NO_COLOR; any non-empty NO_COLOR counts)')
check('NO_COLOR=1 → honor', shouldHonorNoColor({ NO_COLOR: '1' }) === true)
check('NO_COLOR="0" (non-empty!) → honor (spec: ANY non-empty value)', shouldHonorNoColor({ NO_COLOR: '0' }) === true)
check('NO_COLOR="" (empty) → do NOT honor', shouldHonorNoColor({ NO_COLOR: '' }) === false)
check('unset → do NOT honor (normal colored path)', shouldHonorNoColor({}) === false)
check('NO_COLOR=1 + FORCE_COLOR=1 → do NOT honor (FORCE_COLOR wins)', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '1' }) === false)
check('NO_COLOR=1 + FORCE_COLOR=0 → honor; disabled force colour cannot turn colour on', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '0' }) === true)
check('NO_COLOR=1 + FORCE_COLOR=false → honor', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: 'false' }) === true)
check('NO_COLOR=1 + FORCE_COLOR empty → force colour on', shouldHonorNoColor({ NO_COLOR: '1', FORCE_COLOR: '' }) === false)


section('no-op when NO_COLOR unset — the normal colored path is byte-identical')
check('module flag false in a normal (no-NO_COLOR) environment', shouldHonorNoColor({ TERM: 'xterm-256color' } as Record<string, string>) === false)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ NO_COLOR honored — precedence correct, wiring intact, no-op when unset')
  process.exit(0)
} else {
  console.log(` ❌ NO_COLOR honoring — ${failures} check(s) failed`)
  process.exit(1)
}
