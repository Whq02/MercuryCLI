#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-daemon-breaker.ts
//  PROOF: the daemon circuit-breaker (protects autonomous runs from hammering a
//  doomed fleet) implements its 3-state machine correctly — exercised against
//  the REAL production class src/utils/daemonBreaker.ts with an INJECTED clock,
//  so cooldown/half-open transitions are deterministic. This gate had no
//  committed regression coverage. Suppress-only: it can only PAUSE firing.
//
//  Covers: closed allows · consecutive-fail trip · success resets the counter ·
//  window-rate trip · cooldown ⇒ half-open ⇒ probe allowed · half-open success
//  ⇒ closed (recover) · half-open failure ⇒ re-open · isFailureExit mapping.
// ============================================================================

import { DaemonBreaker } from '../../src/utils/daemonBreaker.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
/** A controllable clock so cooldown transitions are deterministic. */
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

console.log('============================================================')
console.log(' Daemon circuit-breaker — state-machine proof')
console.log('============================================================')

section('Closed breaker allows firing')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: () => 0 })
  check('starts closed', b.getState() === 'closed')
  check('closed ⇒ does not suppress', b.shouldSuppressFire() === false)
}

section('Consecutive-failure trip (suppress-only)')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: () => 0 })
  check('1 fail ⇒ still closed', b.recordResult(false) === 'closed')
  check('2 fails ⇒ still closed', b.recordResult(false) === 'closed')
  check('3rd consecutive fail ⇒ OPEN', b.recordResult(false) === 'open')
  check('open ⇒ suppresses firing', b.shouldSuppressFire() === true)
}

section('A success resets the consecutive counter (no premature trip)')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: () => 0 })
  b.recordResult(false); b.recordResult(false)
  check('2 fails then success ⇒ closed', b.recordResult(true) === 'closed')
  check('2 more fails ⇒ still closed (counter reset)', (b.recordResult(false), b.recordResult(false)) === 'closed')
  check('still not suppressing', b.shouldSuppressFire() === false)
}

section('Window failure-rate trip (trips without N-consecutive)')
{
  // window 5, rate 0.8 ⇒ trips at >=4/5 failures even if interleaved.
  const b = new DaemonBreaker({ consecutiveFails: 99, windowSize: 5, failureRate: 0.8, cooldownMs: 1000, now: () => 0 })
  b.recordResult(false); b.recordResult(true); b.recordResult(false); b.recordResult(false)
  check('4 fails / 4 (window not full yet) ⇒ may stay closed', b.getState() === 'closed')
  const st = b.recordResult(false) // window now [f,t,f,f,f] = 4/5 = 0.8 ≥ rate
  check('window reaches the failure rate ⇒ OPEN', st === 'open')
}

section('Cooldown ⇒ half-open ⇒ probe allowed')
{
  const clk = clockFrom(0)
  const b = new DaemonBreaker({ consecutiveFails: 2, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: clk.now })
  b.recordResult(false); b.recordResult(false)
  check('tripped open', b.getState() === 'open')
  check('still open before cooldown elapses', (clk.advance(999), b.shouldSuppressFire()) === true)
  clk.advance(2) // now past cooldown
  check('after cooldown ⇒ half-open (probe allowed, no longer suppressing)', b.shouldSuppressFire() === false)
  check('state is half-open', b.getState() === 'half-open')
}

section('Half-open success ⇒ closed (recovered); half-open failure ⇒ re-open')
{
  const clk = clockFrom(0)
  const mk = () => {
    const b = new DaemonBreaker({ consecutiveFails: 2, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: clk.now })
    b.recordResult(false); b.recordResult(false) // open
    clk.advance(1001) // half-open
    b.getState()
    return b
  }
  const recovered = mk()
  check('half-open + success ⇒ closed', recovered.recordResult(true) === 'closed')
  check('recovered breaker allows firing', recovered.shouldSuppressFire() === false)

  const clk2 = clockFrom(0)
  const b2 = new DaemonBreaker({ consecutiveFails: 2, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: clk2.now })
  b2.recordResult(false); b2.recordResult(false); clk2.advance(1001); b2.getState() // half-open
  check('half-open + failure ⇒ re-open', b2.recordResult(false) === 'open')
  check('re-opened breaker suppresses again', b2.shouldSuppressFire() === true)
}

section('shouldSuppressFire is a PURE query (no admission mutation — caller caps probes)')
{
  // The breaker must NOT mutate on a suppress check: HALF-OPEN single-probe is
  // enforced caller-side (the daemon caps in-flight to 1 while half-open), so a
  // caller early-return between the check and recordResult can never wedge it.
  const clk = clockFrom(0)
  const b = new DaemonBreaker({ consecutiveFails: 2, windowSize: 100, failureRate: 0.99, cooldownMs: 1000, now: clk.now })
  b.recordResult(false); b.recordResult(false); clk.advance(1001) // half-open
  check('half-open: repeated suppress checks all allow (idempotent, no mutation)', b.shouldSuppressFire() === false && b.shouldSuppressFire() === false)
  check('state still half-open after repeated checks', b.getState() === 'half-open')
}

section('isFailureExit maps exit codes correctly')
check('exit 0 ⇒ not a failure', DaemonBreaker.isFailureExit(0) === false)
check('exit 1 ⇒ failure', DaemonBreaker.isFailureExit(1) === true)
check('null (killed/spawn-fail) ⇒ failure', DaemonBreaker.isFailureExit(null) === true)
check('undefined ⇒ failure', DaemonBreaker.isFailureExit(undefined) === true)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-BREAKER PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-BREAKER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
