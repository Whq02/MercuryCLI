#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRateLimitDisplayName } from '../../src/services/claudeAiLimits.js'
import { getRateLimitMessage } from '../../src/services/rateLimitMessages.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' fable weekly window — named on every surface (task #65)')
console.log('============================================================')

check('display name maps to "Fable limit"', getRateLimitDisplayName('seven_day_fable') === 'Fable limit')

const rejected = {
  status: 'rejected' as const,
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  rateLimitType: 'seven_day_fable' as const,
  resetsAt: Math.floor(Date.now() / 1000) + 3600,
}
const msg = getRateLimitMessage(rejected, 'claude-fable-5')?.message ?? ''
check('limit-reached message names the Fable limit', /Fable limit/.test(msg), msg.slice(0, 90))

const msgSrc = readFileSync(join(import.meta.dir, '../../src/services/rateLimitMessages.ts'), 'utf8')
check(
  "early-warning switch carries case 'seven_day_fable' → 'Fable limit'",
  /case 'seven_day_fable':\s*\n\s*limitName = 'Fable limit'/.test(msgSrc),
)
check(
  'the using-overage limitName chain names the Fable limit too',
  /rateLimitType === 'seven_day_fable'\)\s*\{\s*\n\s*limitName = 'Fable limit'/.test(msgSrc),
)

check('Opus label intact', getRateLimitDisplayName('seven_day_opus') === 'Opus limit')
check('weekly label intact', getRateLimitDisplayName('seven_day') === 'weekly limit')

console.log(failures === 0 ? '\n✅ FABLE WEEKLY WINDOW PROOFS PASS' : `\n❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
