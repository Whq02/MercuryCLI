
import {
  isAnalyticsDisabled,
} from '../../src/services/analytics/config.js'
import { binaryName } from '../../src/utils/config.js'

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

function clearAnalyticsEnv(): void {
  delete process.env.MERCURY_TELEMETRY
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
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

console.log('\n[1] product stamp: analytics collection disabled')
setStamp(true)
check('analytics collection is disabled', isAnalyticsDisabled() === true)

console.log('\n[2] bare stamp, clean env: analytics STILL disabled (stamp-independence)')
setStamp(false)
const bareStampAnalytics = isAnalyticsDisabled()
check(`isAnalyticsDisabled() === true under a bare stamp (got ${bareStampAnalytics})`, bareStampAnalytics === true)

console.log('\n[2b] binaryName() — the binary-name long-tail primitive')
setStamp(true)
check(`stamped build: binaryName() === 'mercury' (got '${binaryName()}')`, binaryName() === 'mercury')
setStamp(false)
check(`bare stamp: binaryName() === 'mercury' too (stamp-independence)`, binaryName() === 'mercury')

console.log('\n[3] the env gate still composes (no regression)')
setStamp(false)
process.env.MERCURY_TELEMETRY = '0'
check('MERCURY_TELEMETRY=0 ⇒ isAnalyticsDisabled() === true (env gate intact)', isAnalyticsDisabled() === true)
delete process.env.MERCURY_TELEMETRY

console.log('\n============================================================')
console.log(fail === 0 ? ' ✅ NO-TELEMETRY-EGRESS PROOF PASS' : ' ❌ PROOF FAILED')
console.log('============================================================')
process.exit(fail)
