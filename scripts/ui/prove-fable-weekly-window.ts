#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { getRateLimitDisplayName } from '../../src/models/roads/anthropic/anthropicLimits.js'
import { getRateLimitMessage } from '../../src/models/roads/anthropic/rateLimitMessages.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — ${fixHint}` : ''}`)
}

console.log('============================================================')
console.log(' fable weekly window — named on every surface (task #65)')
console.log('============================================================')

check('display name maps to "Fable limit"', getRateLimitDisplayName('seven_day_fable') === 'Fable limit', '', 'change the seven_day_fable entry of the display names in src/models/roads/anthropic/anthropicLimits.ts (getRateLimitDisplayName)')

const rejected = {
  status: 'rejected' as const,
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  rateLimitType: 'seven_day_fable' as const,
  resetsAt: Math.floor(Date.now() / 1000) + 3600,
}
const msg = getRateLimitMessage(rejected, 'claude-fable-5')?.message ?? ''
check('limit-reached message names the Fable limit', /Fable limit/.test(msg), msg.slice(0, 90), 'change getRateLimitMessage in src/models/roads/anthropic/rateLimitMessages.ts so a rejected seven_day_fable status names the Fable limit')


check('Opus label intact', getRateLimitDisplayName('seven_day_opus') === 'Opus limit', '', 'change the seven_day_opus entry of the display names in src/models/roads/anthropic/anthropicLimits.ts (getRateLimitDisplayName)')
check('weekly label intact', getRateLimitDisplayName('seven_day') === 'weekly limit', '', 'change the seven_day entry of the display names in src/models/roads/anthropic/anthropicLimits.ts (getRateLimitDisplayName)')

console.log(failures === 0 ? '\n✅ FABLE WEEKLY WINDOW PROOFS PASS' : `\n❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
