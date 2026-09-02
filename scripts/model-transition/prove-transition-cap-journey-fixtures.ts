#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-capfix-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { computeNewLimitsFromHeaders } = await import('../../src/services/claudeAiLimits.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const H = (entries: Record<string, string>) => new Headers(entries)
const RESET_AT = 1_754_500_000

const allowed = computeNewLimitsFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed' }))
check('§A allowed: status', allowed.status === 'allowed')
check('§A allowed: not overage', allowed.isUsingOverage === false)

const warning = computeNewLimitsFromHeaders(
  H({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
    'anthropic-ratelimit-unified-reset': String(RESET_AT),
  }),
)
check('§B warning: status', warning.status === 'allowed_warning', warning.status)
check('§B warning: five_hour claim', warning.rateLimitType === 'five_hour', String(warning.rateLimitType))
check('§B warning: threshold carried', warning.surpassedThreshold === 0.9, String(warning.surpassedThreshold))

const rejected = computeNewLimitsFromHeaders(
  H({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(RESET_AT),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  }),
)
check('§C rejected: status', rejected.status === 'rejected')
check('§C rejected: reset time typed', rejected.resetsAt === RESET_AT, String(rejected.resetsAt))
check('§C rejected: claim typed', rejected.rateLimitType === 'five_hour')

const overage = computeNewLimitsFromHeaders(
  H({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(RESET_AT),
    'anthropic-ratelimit-unified-overage-status': 'allowed',
  }),
)
check('§D overage: isUsingOverage', overage.isUsingOverage === true)
check('§D overage: overageStatus carried', overage.overageStatus === 'allowed')

const returned = computeNewLimitsFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed' }))
check('§E return: allowed again', returned.status === 'allowed' && returned.isUsingOverage === false)

console.log(
  failures === 0
    ? '\n ✅ CAP-JOURNEY FIXTURES DETERMINISTIC (allowed → warn → rejected → overage → return)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
