#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-cap-journey-fixtures.ts —
//  the deterministic CAP-JOURNEY FIXTURES over the pure limits parser
//  (computeNewLimitsFromHeaders — the @internal fixture seam; the live
//  extractQuotaStatusFromHeaders path is subscriber-gated and its /mock-
//  limits bypass is dead-gated today: repro-ctm-r04b records that red).
//
//  The canonical R5 journey, phase by phase, as typed limits truth:
//    §A allowed            — clean window
//    §B allowed_warning    — the 5h 90% surpassed-threshold header
//    §C rejected           — window exhausted; typed reset time + claim
//    §D overage arm        — standard rejected, overage allowed ⇒
//                            isUsingOverage (the spend-posture fact the
//                            offer card must show)
//    §E return             — reset truth back to allowed (the posture-
//                            symmetric return signal)
//
//  These fixtures are the ground the cap-survival journeys replay through
//  the UI once the seam gets its Mercury-native opening.
// ============================================================================
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
const RESET_AT = 1_754_500_000 // deterministic epoch seconds

// §A — clean window.
const allowed = computeNewLimitsFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed' }))
check('§A allowed: status', allowed.status === 'allowed')
check('§A allowed: not overage', allowed.isUsingOverage === false)

// §B — the 5h early-warning threshold (server surpassed-threshold header).
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

// §C — exhausted window: typed rejection with reset truth.
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

// §D — the overage arm: standard rejected + overage allowed ⇒ isUsingOverage.
const overage = computeNewLimitsFromHeaders(
  H({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(RESET_AT),
    'anthropic-ratelimit-unified-overage-status': 'allowed',
  }),
)
check('§D overage: isUsingOverage', overage.isUsingOverage === true)
check('§D overage: overageStatus carried', overage.overageStatus === 'allowed')

// §E — reset: the posture-symmetric return signal.
const returned = computeNewLimitsFromHeaders(H({ 'anthropic-ratelimit-unified-status': 'allowed' }))
check('§E return: allowed again', returned.status === 'allowed' && returned.isUsingOverage === false)

console.log(
  failures === 0
    ? '\n ✅ CAP-JOURNEY FIXTURES DETERMINISTIC (allowed → warn → rejected → overage → return)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
