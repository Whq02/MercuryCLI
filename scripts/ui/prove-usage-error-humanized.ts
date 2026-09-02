#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { humanizeUsageError } = await import('../../src/components/Settings/Usage.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' /usage error presentation — human lines, never raw JSON')
console.log('============================================================')

const rateLimited = { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }
check(
  'rate_limit_error (object) → the human retry line',
  humanizeUsageError(rateLimited) === 'rate limited — usage data is temporarily unavailable, retry in a moment',
  String(humanizeUsageError(rateLimited)),
)
check(
  'rate_limit_error (JSON string) → the same human line',
  humanizeUsageError(JSON.stringify(rateLimited)) ===
    'rate limited — usage data is temporarily unavailable, retry in a moment',
)
check(
  'no raw JSON braces survive in the human line',
  !String(humanizeUsageError(rateLimited)).includes('{'),
)
check(
  'overloaded_error → a human line',
  String(humanizeUsageError({ error: { type: 'overloaded_error' } })).includes('overloaded'),
)
check(
  'unknown typed error → its message + type',
  humanizeUsageError({ error: { type: 'weird_error', message: 'Something odd.' } }) ===
    'Something odd. (weird_error)',
)
check('unparseable body → null (caller keeps its raw fallback)', humanizeUsageError('not json') === null)
check('non-error shape → null', humanizeUsageError({ ok: true }) === null)

console.log()
if (failures > 0) {
  console.log(`❌ USAGE-ERROR PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ USAGE-ERROR PROOF PASS')
