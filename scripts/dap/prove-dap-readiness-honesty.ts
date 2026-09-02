#!/usr/bin/env bun
// prove-dap-readiness-honesty — two DAP readiness defects (field cards
// FC-053 · FC-054).
//
// FC-053: a SET-but-missing MERCURY_JS_DEBUG_DAP produced a readiness row
//   asserting two false facts — variable unset, no vendored bundle. The
//   unavailable arm now reads the pin's own state and names the exclusive
//   refusal. FC-054: the interpreter ladder never tried `py` on win32, so a
//   Windows-Python-Launcher-only box read the lane unavailable with a
//   remedy naming neither cause nor fix.
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { defaultInterpreterCandidates } = await import('../../src/services/dap/debugpyResolver.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// FC-054 — platform-keyed: py joins ONLY on win32.
const candidates = defaultInterpreterCandidates()
if (process.platform === 'win32') {
  check('win32: py is a candidate (FC-054)', candidates.includes('py'), JSON.stringify(candidates))
} else {
  check('off win32: py is NOT a candidate (no blanket widening)', !candidates.includes('py'), JSON.stringify(candidates))
}
const resolver = readFileSync(join(import.meta.dir, '../../src/services/dap/debugpyResolver.ts'), 'utf8')
check("the py candidate is win32-keyed (call-shaped)", /process\.platform === 'win32'\) out\.push\('py'\)/.test(resolver))
check("the default roster is present (rot-proof anchor)", resolver.includes("['python3', 'python']") && resolver.includes("out.push('py')"))
check('and rides LAST so a real python keeps winning', resolver.indexOf("out.push('py')") > resolver.indexOf("['python3', 'python']"))

// FC-053 — the pin-aware unavailable arm (call-shaped).
const readiness = readFileSync(join(import.meta.dir, '../../src/utils/readiness.ts'), 'utf8')
check(
  'the js-debug unavailable arm reads the PIN state first (FC-053)',
  /pinnedJsDebug && pinnedJsDebug\.length > 0/.test(readiness),
)
check(
  'and the pinned-missing detail names the exclusive refusal, never "unset"',
  /is set but \$\{pinnedJsDebug\} does not exist/.test(readiness),
)

if (failures > 0) {
  console.error(`\nprove-dap-readiness-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-dap-readiness-honesty: all green')
