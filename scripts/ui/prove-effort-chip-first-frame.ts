#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const { focusedEffortLabelOf } = await import('../../src/components/mercury-ui/EffortChip.tsx')
const model = 'claude-opus-5'
console.log('§1 the chip: the seat word paints plain while the runner has not said what it sends')
check('a seat word with no sent word yet reads plain for the chip', focusedEffortLabelOf(model, 'high', undefined, undefined, null, false) === 'high', focusedEffortLabelOf(model, 'high', undefined, undefined, null, false))
check('the same facts keep the asked mark for the readers that want it (the /effort column, the slider)', focusedEffortLabelOf(model, 'high', undefined, undefined) === 'high (asked)', focusedEffortLabelOf(model, 'high', undefined, undefined))
check('the sent word wins everywhere once the runner speaks', focusedEffortLabelOf(model, 'max', 'high', undefined, null, false) === 'high' && focusedEffortLabelOf(model, 'max', 'high', undefined) === 'high')
check('a born word paints plain on both roads', focusedEffortLabelOf(model, null, undefined, undefined, 'max', false) === 'max' && focusedEffortLabelOf(model, null, undefined, undefined, 'max') === 'max')
console.log('§2 the chip is the one caller that turns the mark off')
const chip = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/EffortChip.tsx'), 'utf8')
check('the chip passes the plain flag', chip.includes('focusedEffortLabelOf(model, seatEffort, sentEffort, effortValue, bornEffort, false)'))
const slider = readFileSync(join(import.meta.dir, '../../src/commands/effort/EffortSlider.tsx'), 'utf8')
check('the slider keeps the asked mark as shipped', slider.includes('focusedEffortLabelOf(model, seatEffort, sentEffort, effortValue)'))
console.log(`\n${failures === 0 ? '✅' : '❌'} effort-chip-first-frame — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
