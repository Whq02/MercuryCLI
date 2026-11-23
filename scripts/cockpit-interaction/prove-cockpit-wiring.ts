#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import {
  helmRowAction,
  helmRowSig,
  type HelmRow,
} from '../../src/screen/cockpit/helmFocus.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' cockpit wiring — focus model · input owner · vitals rail')
console.log('============================================================')

section('helmFocus — no console row kind (pure)')
const commandRow: HelmRow = { kind: 'command', command: '/health', label: 'open' }
check('a command row is a plain command action', helmRowAction(commandRow)?.type === 'command' && helmRowSig(commandRow) === 'c:/health:open', '', 'change helmRowAction (type command) or helmRowSig (c:<command>:<label>) in src/screen/cockpit/helmFocus.ts')


console.log('')
if (failures > 0) {
  console.log(`❌ prove-cockpit-wiring: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-cockpit-wiring: ALL GREEN')
