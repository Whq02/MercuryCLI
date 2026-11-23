#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { hiddenAgentToolUses } from '../../src/tools/crewmate/rows.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('agent-card fold: click reveals, cue never lies')

check('hiddenAgentToolUses is total on empty progress', hiddenAgentToolUses([], [] as never) === 0, 'to fix, make hiddenAgentToolUses in src/tools/crewmate/rows.tsx return 0 for empty progress and empty tools')


console.log('\n' + '='.repeat(76))
if (failures === 0) {
  console.log('✅ AGENT FOLD CLICK: green')
  process.exit(0)
} else {
  console.log(`❌ AGENT FOLD CLICK: ${failures} check(s) failed`)
  process.exit(1)
}
