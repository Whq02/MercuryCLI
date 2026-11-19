#!/usr/bin/env bun

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}


console.log('============================================================')
console.log(' main() boot-order contract (Phase 10.1)')
console.log('============================================================')


const { firstSystemPrompt } = await import('../lib/builtProduct.ts')
check('B7 runHeadless stamps NON-INTERACTIVE before any system-prompt composition', /^- Session: non-interactive/m.test(await firstSystemPrompt()))


console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ BOOT ORDER CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} BOOT ORDER FAILURE(S)`)
process.exit(1)
