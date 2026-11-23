#!/usr/bin/env bun
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = '', failHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && failHint ? ` — ${failHint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Daemon breaker — wall-clock TIMEOUT carve-out (feature B)')
console.log('============================================================')

const { DaemonBreaker } = (await import('../../src/daemon/control/daemonBreaker.js')) as typeof import('../../src/daemon/control/daemonBreaker.js')

section('recordTimeout(): N timeouts in a row stay CLOSED (vs recordResult ⇒ OPEN)')
{
  const mk = () => new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  const crash = mk()
  crash.recordResult(false); crash.recordResult(false)
  check('control: 3 consecutive recordResult(false) ⇒ OPEN', crash.recordResult(false) === 'open', '', 'DaemonBreaker.recordResult in src/daemon/control/daemonBreaker.ts must open the breaker after consecutiveFails failures in a row')

  const timeouts = mk()
  let st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  check('5 consecutive recordTimeout() ⇒ still CLOSED (no consecutive trip)', st === 'closed', '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must not count a timeout toward the consecutive-failure trip')
  check('breaker does NOT suppress firing after 5 timeouts', timeouts.shouldSuppressFire() === false, '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must leave the breaker closed so shouldSuppressFire stays false')
  check('consecutiveFailures stays 0 across timeouts', timeouts.getStatus().consecutiveFailures === 0, '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must not raise consecutiveFailures')
}

section('recordTimeout() RESETS a primed consecutive streak')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  b.recordResult(false); b.recordResult(false)
  check('primed at 2 consecutive failures', b.getStatus().consecutiveFailures === 2, '', 'DaemonBreaker.recordResult in src/daemon/control/daemonBreaker.ts must count each failed result in consecutiveFailures')
  b.recordTimeout()
  check('after a timeout the streak is reset to 0', b.getStatus().consecutiveFailures === 0, '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must reset consecutiveFailures to 0')
  check('a 3rd real failure now ⇒ only 1, still CLOSED', b.recordResult(false) === 'closed', '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must reset the streak so the next failure counts as the first')
}

section('window-rate backstop: an ALL-timeout window still trips (wedged spawner)')
{
  const b = new DaemonBreaker({ consecutiveFails: 100, windowSize: 4, failureRate: 0.75, cooldownMs: 1000, now: () => 0 })
  b.recordTimeout(); b.recordTimeout(); b.recordTimeout()
  check('3 timeouts (window not full) ⇒ CLOSED', b.getState() === 'closed', '', 'DaemonBreaker in src/daemon/control/daemonBreaker.ts must not open on a window that is not yet full')
  check('4th timeout fills the window at rate 1.0 ⇒ OPEN (leash holds)', b.recordTimeout() === 'open', '', 'DaemonBreaker.recordTimeout in src/daemon/control/daemonBreaker.ts must still record the timeout in the failure-rate window so a full window of timeouts opens the breaker')
}

section('timeoutIsFleetFailure(): DEFAULT true (byte-identical), opt-in =1 ⇒ false')
{
  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  check('unset ⇒ timeout IS a fleet failure (today, byte-identical)', DaemonBreaker.timeoutIsFleetFailure() === true, '', 'DaemonBreaker.timeoutIsFleetFailure in src/daemon/control/daemonBreaker.ts must return true when MERCURY_DAEMON_BREAKER_TIMEOUT_OK is unset')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  check('=1 ⇒ carve-out armed (timeout is NOT a fleet failure)', DaemonBreaker.timeoutIsFleetFailure() === false, '', 'DaemonBreaker.timeoutIsFleetFailure in src/daemon/control/daemonBreaker.ts must return false when MERCURY_DAEMON_BREAKER_TIMEOUT_OK is 1')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '0'
  check('=0 ⇒ still a fleet failure (explicit old behavior)', DaemonBreaker.timeoutIsFleetFailure() === true, '', 'DaemonBreaker.timeoutIsFleetFailure in src/daemon/control/daemonBreaker.ts must return true for any value other than 1')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = 'yes'
  check('garbage ⇒ still a fleet failure (fail-safe)', DaemonBreaker.timeoutIsFleetFailure() === true, '', 'DaemonBreaker.timeoutIsFleetFailure in src/daemon/control/daemonBreaker.ts must return true for any value other than 1')
  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}

section('END-TO-END: real runTaskHeadless sets timedOut:true on a wall-clock cap')
{
  const hr = (await import('../../src/daemon/runner-link/headlessRun.js')) as typeof import('../../src/daemon/runner-link/headlessRun.js')

  const dir = mkdtempSync(join(tmpdir(), 'breaker-timeout-'))
  const childScript = join(dir, 'stubborn-child.mjs')
  writeFileSync(
    childScript,
    [
      "process.on('SIGTERM', () => {})",
      'setTimeout(() => process.exit(0), 60000)',
    ].join('\n'),
  )

  const realArgv1 = process.argv[1]
  process.argv[1] = childScript
  let res: import('../../src/daemon/runner-link/headlessRun.js').HeadlessResult
  try {
    res = await hr.runTaskHeadless({ id: 'to-test', prompt: 'noop' }, dir, undefined, 200)
  } finally {
    process.argv[1] = realArgv1
  }
  check('runTaskHeadless resolved (never rejects)', res !== undefined, '', 'runTaskHeadless in src/daemon/runner-link/headlessRun.ts must resolve with a result and never reject')
  check('result.timedOut === true on a wall-clock cap (flag is LIVE)', res.timedOut === true, '', 'runTaskHeadless in src/daemon/runner-link/headlessRun.ts must set timedOut: true on the result when the wall-clock cap kills the child')
  check('result.code === null (SIGKILLed)', res.code === null, '', 'runTaskHeadless in src/daemon/runner-link/headlessRun.ts must return code null when it SIGKILLs the child at the cap')

  const feed = (r: import('../../src/daemon/runner-link/headlessRun.js').HeadlessResult, b: InstanceType<typeof DaemonBreaker>) => {
    const failed = DaemonBreaker.isFailureExit(r.code)
    if (r.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) return b.recordTimeout()
    return b.recordResult(!failed)
  }

  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK

  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  const off = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, off); feed(res, off)
  check('DEFAULT: 3 real-timeout results ⇒ OPEN (byte-identical to today)', feed(res, off) === 'open', '', 'with the flag unset, timeoutIsFleetFailure in src/daemon/control/daemonBreaker.ts must be true so timed-out results go to recordResult and open the breaker')

  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  const on = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, on); feed(res, on); feed(res, on); feed(res, on); feed(res, on)
  check('OPT-IN: 5 real-timeout results ⇒ still CLOSED (fleet not paused)', on.getState() === 'closed', '', 'with MERCURY_DAEMON_BREAKER_TIMEOUT_OK=1, timed-out results must go to DaemonBreaker.recordTimeout (src/daemon/control/daemonBreaker.ts) and leave the breaker closed')

  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BREAKER-TIMEOUT PROOFS PASS')
else console.log(`❌ ${failures} BREAKER-TIMEOUT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
