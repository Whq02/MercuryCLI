#!/usr/bin/env bun
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const CHROME_HINT = 'consentContentWidth and CONSENT_CARD_CHROME_COLUMNS in src/permissions/cards/consentBodyBudget.ts must subtract the card borders, outer padding and inner padding from the columns'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)
const { consentContentWidth, CONSENT_CARD_CHROME_COLUMNS } = await import('../../src/permissions/cards/consentBodyBudget.ts')

console.log('============================================================')
console.log(' permission diff width — the card chrome subtraction')
console.log('============================================================')

check('the owner counts the borders and the outer padding (four cells) plus the inner padding', CONSENT_CARD_CHROME_COLUMNS === 4 && consentContentWidth(100) === 94 && consentContentWidth(100, 0) === 96, '', CHROME_HINT)

section('behavioral: width arithmetic (measured on the built bundle at 100 and 110 columns)')
const editWidth = (cols: number) => Math.max(1, cols > 80 ? consentContentWidth(cols) - 4 : consentContentWidth(cols))
const writeWidth = (cols: number) => Math.max(1, consentContentWidth(cols) - 2)
check('FileEdit @100 framed: 90 cells (100 − 6 − 4) — the box the frame showed', editWidth(100) === 90, '', CHROME_HINT)
check('FileEdit @110 framed: 100 cells — the 100 visible cells of the reproduction', editWidth(110) === 100, '', CHROME_HINT)
check('FileEdit @80 unframed: 74 cells (80 − 6)', editWidth(80) === 74, '', CHROME_HINT)
check('FileWrite @100: 92 cells (100 − 6 − 2)', writeWidth(100) === 92, '', CHROME_HINT)
check('FileWrite @120: 112 cells', writeWidth(120) === 112, '', CHROME_HINT)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ permission diff width — the card chrome subtraction proven')
  process.exit(0)
} else {
  console.log(` ❌ permission diff width — ${failures} check(s) failed`)
  process.exit(1)
}
