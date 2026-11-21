#!/usr/bin/env bun
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Daemon breaker — wall-clock TIMEOUT carve-out (feature B)')
console.log('============================================================')

const { DaemonBreaker } = (await import('../../src/utils/daemonBreaker.js')) as typeof import('../../src/utils/daemonBreaker.js')

section('recordTimeout(): N timeouts in a row stay CLOSED (vs recordResult ⇒ OPEN)')
{
  const mk = () => new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  const crash = mk()
  crash.recordResult(false); crash.recordResult(false)
  check('control: 3 consecutive recordResult(false) ⇒ OPEN', crash.recordResult(false) === 'open', 'DaemonBreaker.recordResult(false) must trip at consecutiveFails (src/utils/daemonBreaker.ts)')

  const timeouts = mk()
  let st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  check('5 consecutive recordTimeout() ⇒ still CLOSED (no consecutive trip)', st === 'closed', `state=${st}; recordTimeout() must not count toward the consecutive trip (src/utils/daemonBreaker.ts)`)
  check('breaker does NOT suppress firing after 5 timeouts', timeouts.shouldSuppressFire() === false, 'shouldSuppressFire() must stay false while the breaker is closed (src/utils/daemonBreaker.ts)')
  check('consecutiveFailures stays 0 across timeouts', timeouts.getStatus().consecutiveFailures === 0, `consecutiveFailures=${timeouts.getStatus().consecutiveFailures}; recordTimeout() must not raise it (src/utils/daemonBreaker.ts)`)
}

section('recordTimeout() RESETS a primed consecutive streak')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  b.recordResult(false); b.recordResult(false)
  check('primed at 2 consecutive failures', b.getStatus().consecutiveFailures === 2, `consecutiveFailures=${b.getStatus().consecutiveFailures}; recordResult(false) must count a failure (src/utils/daemonBreaker.ts)`)
  b.recordTimeout()
  check('after a timeout the streak is reset to 0', b.getStatus().consecutiveFailures === 0, `consecutiveFailures=${b.getStatus().consecutiveFailures}; recordTimeout() must reset the consecutive streak (src/utils/daemonBreaker.ts)`)
  check('a 3rd real failure now ⇒ only 1, still CLOSED', b.recordResult(false) === 'closed', 'after the reset one real failure must leave the breaker closed (recordTimeout and recordResult in src/utils/daemonBreaker.ts)')
}

section('window-rate backstop: an ALL-timeout window still trips (wedged spawner)')
{
  const b = new DaemonBreaker({ consecutiveFails: 100, windowSize: 4, failureRate: 0.75, cooldownMs: 1000, now: () => 0 })
  b.recordTimeout(); b.recordTimeout(); b.recordTimeout()
  check('3 timeouts (window not full) ⇒ CLOSED', b.getState() === 'closed', `state=${b.getState()}; recordTimeout() must not trip before the window is full (src/utils/daemonBreaker.ts)`)
  check('4th timeout fills the window at rate 1.0 ⇒ OPEN (leash holds)', b.recordTimeout() === 'open', 'recordTimeout() must still feed the failure-rate window so an all-timeout window opens (src/utils/daemonBreaker.ts)')
}

section('timeoutIsFleetFailure(): DEFAULT true (byte-identical), opt-in =1 ⇒ false')
{
  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  check('unset ⇒ timeout IS a fleet failure (today, byte-identical)', DaemonBreaker.timeoutIsFleetFailure() === true, 'DaemonBreaker.timeoutIsFleetFailure() must be true when MERCURY_DAEMON_BREAKER_TIMEOUT_OK is unset (src/utils/daemonBreaker.ts)')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  check('=1 ⇒ carve-out armed (timeout is NOT a fleet failure)', DaemonBreaker.timeoutIsFleetFailure() === false, 'timeoutIsFleetFailure() must be false only when MERCURY_DAEMON_BREAKER_TIMEOUT_OK is 1 (src/utils/daemonBreaker.ts)')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '0'
  check('=0 ⇒ still a fleet failure (explicit old behavior)', DaemonBreaker.timeoutIsFleetFailure() === true, 'timeoutIsFleetFailure() must stay true when MERCURY_DAEMON_BREAKER_TIMEOUT_OK is 0 (src/utils/daemonBreaker.ts)')
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = 'yes'
  check('garbage ⇒ still a fleet failure (fail-safe)', DaemonBreaker.timeoutIsFleetFailure() === true, 'timeoutIsFleetFailure() must stay true for any value other than 1 (src/utils/daemonBreaker.ts)')
  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}

section('END-TO-END: real runTaskHeadless sets timedOut:true on a wall-clock cap')
{
  const hr = (await import('../../src/daemon/headlessRun.js')) as typeof import('../../src/daemon/headlessRun.js')

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
  let res: import('../../src/daemon/headlessRun.js').HeadlessResult
  try {
    res = await hr.runTaskHeadless({ id: 'to-test', prompt: 'noop' }, dir, undefined, 200)
  } finally {
    process.argv[1] = realArgv1
  }
  check('runTaskHeadless resolved (never rejects)', res !== undefined, 'runTaskHeadless must always resolve a HeadlessResult (src/daemon/headlessRun.ts)')
  check('result.timedOut === true on a wall-clock cap (flag is LIVE)', res.timedOut === true, `timedOut=${String(res.timedOut)}; runTaskHeadless must set timedOut:true when the wall-clock cap kills the child (src/daemon/headlessRun.ts)`)
  check('result.code === null (SIGKILLed)', res.code === null, `code=${String(res.code)}; a SIGKILLed child must report code null (runTaskHeadless in src/daemon/headlessRun.ts)`)

  const feed = (r: import('../../src/daemon/headlessRun.js').HeadlessResult, b: InstanceType<typeof DaemonBreaker>) => {
    const failed = DaemonBreaker.isFailureExit(r.code)
    if (r.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) return b.recordTimeout()
    return b.recordResult(!failed)
  }

  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK

  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  const off = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, off); feed(res, off)
  check('DEFAULT: 3 real-timeout results ⇒ OPEN (byte-identical to today)', feed(res, off) === 'open', 'with the flag unset a timed-out result must count as a failure through DaemonBreaker.recordResult (src/utils/daemonBreaker.ts)')

  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  const on = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, on); feed(res, on); feed(res, on); feed(res, on); feed(res, on)
  check('OPT-IN: 5 real-timeout results ⇒ still CLOSED (fleet not paused)', on.getState() === 'closed', `state=${on.getState()}; with MERCURY_DAEMON_BREAKER_TIMEOUT_OK=1 a timed-out result must go to recordTimeout (src/utils/daemonBreaker.ts, src/daemon/headlessRun.ts timedOut)`)

  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BREAKER-TIMEOUT PROOFS PASS')
else console.log(`❌ ${failures} BREAKER-TIMEOUT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
