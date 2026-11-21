#!/usr/bin/env bun
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
const HINT_WIDTH = 'what to change: CONSENT_CARD_CHROME_COLUMNS or consentContentWidth in src/components/permissions/consentBodyBudget.ts, so the card chrome subtraction gives the width the check names'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)
const { consentContentWidth, CONSENT_CARD_CHROME_COLUMNS } = await import('../../src/components/permissions/consentBodyBudget.ts')

console.log('============================================================')
console.log(' permission diff width — the card chrome subtraction')
console.log('============================================================')

check('the owner counts the borders and the outer padding (four cells) plus the inner padding', CONSENT_CARD_CHROME_COLUMNS === 4 && consentContentWidth(100) === 94 && consentContentWidth(100, 0) === 96, `chrome ${CONSENT_CARD_CHROME_COLUMNS} (want 4) · width(100) ${consentContentWidth(100)} (want 94) · width(100, 0) ${consentContentWidth(100, 0)} (want 96) · ${HINT_WIDTH}`)

section('behavioral: width arithmetic (measured on the built bundle at 100 and 110 columns)')
const editWidth = (cols: number) => Math.max(1, cols > 80 ? consentContentWidth(cols) - 4 : consentContentWidth(cols))
const writeWidth = (cols: number) => Math.max(1, consentContentWidth(cols) - 2)
check('FileEdit @100 framed: 90 cells (100 − 6 − 4) — the box the frame showed', editWidth(100) === 90, `got ${editWidth(100)} · ${HINT_WIDTH}`)
check('FileEdit @110 framed: 100 cells — the 100 visible cells of the reproduction', editWidth(110) === 100, `got ${editWidth(110)} · ${HINT_WIDTH}`)
check('FileEdit @80 unframed: 74 cells (80 − 6)', editWidth(80) === 74, `got ${editWidth(80)} · ${HINT_WIDTH}`)
check('FileWrite @100: 92 cells (100 − 6 − 2)', writeWidth(100) === 92, `got ${writeWidth(100)} · ${HINT_WIDTH}`)
check('FileWrite @120: 112 cells', writeWidth(120) === 112, `got ${writeWidth(120)} · ${HINT_WIDTH}`)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ permission diff width — the card chrome subtraction proven')
  process.exit(0)
} else {
  console.log(` ❌ permission diff width — ${failures} check(s) failed`)
  process.exit(1)
}
