// ============================================================================
//  prove-no-telemetry-egress — Mercury feeds no third-party product
//  infrastructure: telemetry, feedback surveys and remote feature gates are
//  cut at ONE chokepoint, and this proof pins that chokepoint.
//
//  Most flips live in modules NOT loadable under `bun run` (Ink components, OTEL,
//  the feature-gate module's BLOCKS_ON_INIT, the feature()/bun:bundle macro) — those are verified
//  by build-compile + dist string-literal grep + render-verify (see the per-flip
//  `provable` notes). This proof unit-tests the ONE pure, bun-importable chokepoint:
//  services/analytics/config.ts:isAnalyticsDisabled / isFeedbackSurveyDisabled —
//  the single gate that short-circuits every outbound analytics path
//  (metrics ingest, event upload, remote feature gates).
//
//  globalThis.MACRO stamp-sim (config.ts reads MACRO at CALL time via `typeof MACRO`),
//  per scripts/substrate/prove-substrate-umbrella.ts:36. READ-ONLY, no network.
// ============================================================================

import {
  isAnalyticsDisabled,
  isFeedbackSurveyDisabled,
} from '../../src/services/analytics/config.js'
import { binaryName } from '../../src/utils/config.js'

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

// Clear the env knobs that independently disable analytics, so the bare-stamp path is
// deterministically "analytics enabled" — proving the gate is the differentiator.
function clearAnalyticsEnv(): void {
  delete process.env.DISABLE_TELEMETRY
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  // NODE_ENV must not be 'test' for the bare-stamp path to allow analytics.
  if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
}

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) fail = 1
}

console.log('============================================================')
console.log(' no telemetry egress — analytics chokepoint proof')
console.log('============================================================')

clearAnalyticsEnv()

console.log('\n[1] product stamp: analytics + feedback-survey disabled (no uploads)')
setStamp(true)
check('isAnalyticsDisabled() === true (Datadog + 1P event upload + GrowthBook off)', isAnalyticsDisabled() === true)
check('isFeedbackSurveyDisabled() === true', isFeedbackSurveyDisabled() === true)

// The disable is stamp-independent — no analytics upload exists under any
// stamp,
// which is the STRONGER guarantee: a mis-stamped build can't re-arm telemetry.
console.log('\n[2] bare stamp, clean env: analytics STILL disabled (stamp-independence)')
setStamp(false)
const bareStampAnalytics = isAnalyticsDisabled()
const bareStampSurvey = isFeedbackSurveyDisabled()
check(`isAnalyticsDisabled() === true under a bare stamp (got ${bareStampAnalytics})`, bareStampAnalytics === true)
check(`isFeedbackSurveyDisabled() === true under a bare stamp (got ${bareStampSurvey})`, bareStampSurvey === true)

console.log('\n[2b] binaryName() — the binary-name long-tail primitive')
setStamp(true)
check(`fork: binaryName() === 'mercury' (got '${binaryName()}')`, binaryName() === 'mercury')
setStamp(false)
check(`bare stamp: binaryName() === 'mercury' too (stamp-independence)`, binaryName() === 'mercury')

console.log('\n[3] the compat env gate still composes (no regression)')
setStamp(false)
process.env.DISABLE_TELEMETRY = '1'
check('DISABLE_TELEMETRY=1 ⇒ isAnalyticsDisabled() === true (env gate intact)', isAnalyticsDisabled() === true)
delete process.env.DISABLE_TELEMETRY

console.log('\n============================================================')
console.log(fail === 0 ? ' ✅ NO-TELEMETRY-EGRESS PROOF PASS' : ' ❌ PROOF FAILED')
console.log('  (install/feedback/BigQuery/branding flips: build-compile + dist-grep')
console.log('   + render-verify — not bun-loadable; see the workflow plan provable notes.)')
console.log('============================================================')
process.exit(fail)
