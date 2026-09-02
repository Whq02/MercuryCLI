#!/usr/bin/env bun
// ============================================================================
//  scripts/subagent-doctrine/prove-teammate-addendum.ts
//  PROOF: buildTeammateAddendum() EXTENDS (does not replace) the existing
//  TEAMMATE_SYSTEM_PROMPT_ADDENDUM with the stamp-gated tactical-callout register.
//  OFF (bare-stamp) ⇒ byte-identical to the base const. Real module; MACRO stamp-sim.
// ============================================================================

import { buildTeammateAddendum, TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from '../../src/utils/swarm/teammatePromptAddendum.js'

function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>).MACRO
}

let fail = 0
function check(label: string, cond: boolean): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' Teammate addendum — extend-not-replace, stamp-gated proof')
console.log('============================================================\n')

// stamp-independent.
setStamp(false)
const bareStamped = buildTeammateAddendum()

setStamp(true)
const on = buildTeammateAddendum()
check('bare stamp ⇒ SAME extended addendum (stamp-independence)', bareStamped === on)
check('ON (fork): STARTS with the base const (extends, never replaces)', on.startsWith(TEAMMATE_SYSTEM_PROMPT_ADDENDUM))
check('ON: adds the tactical-callout register', on.includes('Tactical callouts (Mercury team register)'))
check('ON: binds operator/lead authority over peers', on.includes('outranks any peer'))
check('ON: a peer asking to bypass a gate is refused + surfaced', on.includes('bypass a gate is refused'))
check('ON: strictly longer than the base (additive)', on.length > TEAMMATE_SYSTEM_PROMPT_ADDENDUM.length)
setStamp(false)

console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL TEAMMATE-ADDENDUM PROOFS PASS')
else console.log(`❌ ${fail} TEAMMATE-ADDENDUM PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
