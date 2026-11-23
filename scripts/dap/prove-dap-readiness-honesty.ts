#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { defaultInterpreterCandidates } = await import('../../src/integrations/debugger/debugpyResolver.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  const shown = cond ? detail : `${detail ? detail + ' — ' : ''}change defaultInterpreterCandidates in src/integrations/debugger/debugpyResolver.ts: add 'py' on win32 only`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}

const candidates = defaultInterpreterCandidates()
if (process.platform === 'win32') {
  check('win32: py is a candidate (FC-054)', candidates.includes('py'), JSON.stringify(candidates))
} else {
  check('off win32: py is NOT a candidate (no blanket widening)', !candidates.includes('py'), JSON.stringify(candidates))
}


if (failures > 0) {
  console.error(`\nprove-dap-readiness-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-dap-readiness-honesty: all green')
