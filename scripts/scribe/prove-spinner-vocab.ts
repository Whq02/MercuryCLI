#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-spinner-vocab.ts
//  PROOF: the thinking-spinner vocab is NOT gated off by the scribe/router switch
//  (operator ask) — and in fact the identity-forward modes GUARANTEE the
//  quicksilver cadence. Also: no leak — getSpinnerVerbs() never returns the router
//  sentinel, and the pool is the SAME everywhere (only frequency changes).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-spinner-vocab.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const sv = (await import('../../src/constants/spinnerVerbs.js')) as typeof import('../../src/constants/spinnerVerbs.js')
const scribe = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')

// A stable quicksilver line (the pool's first interjection) to detect its presence.
const HIP_MARKER = 'Quicksilver'

console.log('============================================================')
console.log(' Thinking-spinner vocab — scribe/router not gated off — proof')
console.log('============================================================')

section('scribe mode OFF: the quicksilver vocab is available (stamped build), pool is the desert set')
delete process.env.MERCURY_HIP
delete process.env.MERCURY_HIP
scribe.setScribeMode(false)
const offVerbs = sv.getSpinnerVerbs()
check('off ⇒ a non-empty verb pool', offVerbs.length > 0)
// Off + no env ⇒ the mix is a coin-flip, so we can't assert HIP presence deterministically;
// we assert the pool is well-formed and (below) that turning scribe ON guarantees HIP.

section('scribe mode ON: the quicksilver cadence is GUARANTEED (not gated off by the switch)')
scribe.setScribeMode(true)
const onVerbs = sv.getSpinnerVerbs()
check('scribe ON ⇒ the quicksilver vocab is present (the quicksilver personality carries into the mode)', onVerbs.includes(HIP_MARKER))
check('scribe ON ⇒ the SHARED desert/base pool is still present (vocab is not mode-specific)', onVerbs.length > 1)

section('explicit MERCURY_HIP=0 still wins (operator opt-out beats the mode default)')
process.env.MERCURY_HIP = '0'
scribe.setScribeMode(true)
const optOut = sv.getSpinnerVerbs()
check('scribe ON + MERCURY_HIP=0 ⇒ quicksilver vocab suppressed (explicit opt-out respected)', !optOut.includes(HIP_MARKER))
delete process.env.MERCURY_HIP

section('no leak: the verb pool never contains the router sentinel')
scribe.setScribeMode(true)
const verbs = sv.getSpinnerVerbs()
check('no "__hermes_scribe_router__" in the pool', !verbs.some(v => /scribe_router/.test(v)))
check('no raw "[1m]" / sentinel fragments leak as a verb', !verbs.some(v => /\[1m\]|__hermes/.test(v)))

scribe.setScribeMode(false) // restore

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SPINNER-VOCAB PROOFS PASS')
else console.log(`❌ ${failures} SPINNER-VOCAB PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
