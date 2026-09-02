#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-breaker-timeout.ts
//  PROOF (daemon & swarm robustness — feature B): a wall-clock TIMEOUT must not
//  spuriously trip the daemon's global circuit-breaker as if it were a crash.
//
//  Today a run that overruns its per-run cap closes with `code === null`, so the
//  feed sites (main.ts onFireTask, roster.ts dispatch) treat it as a hard failure
//  via recordResult(false) — N long fires in a row can trip the consecutive brake
//  and pause the whole fleet. The fix wires HeadlessResult.timedOut through a new
//  recordTimeout() (window-rate-only, never the consecutive trip), behind the
//  OPT-IN knob MERCURY_DAEMON_BREAKER_TIMEOUT_OK=1 (DEFAULT unset ⇒ byte-identical).
//
//  This proof exercises the REAL code paths and asserts the REAL outcomes — it is
//  NOT a gate-truth-table + dist-grep that would pass whether or not the feature
//  works:
//    1. recordTimeout() on the REAL DaemonBreaker class: 5 timeouts in a row stay
//       CLOSED, whereas 5 recordResult(false) trip OPEN — the behavioural delta.
//    2. recordTimeout() RESETS a primed consecutive streak (a long task after near-
//       crashes does not become the Nth failure).
//    3. The window-rate backstop STILL trips on an all-timeout window (a wedged
//       spawner is still caught).
//    4. The gate timeoutIsFleetFailure(): DEFAULT true (byte-identical), =1 ⇒ false
//       (carve-out armed), =0 / other ⇒ true.
//    5. END-TO-END: drive the REAL runTaskHeadless against a child that IGNORES
//       SIGTERM and sleeps past a tiny cap — assert the resolved result carries
//       timedOut:true (proves the headlessRun flag is LIVE, not the dead-flag trap),
//       then feed THAT real result through the SAME branch the feed sites use and
//       assert the breaker is routed correctly under each gate setting.
//    6. STRUCTURAL: both feed sites actually call the carve-out branch (wired, not
//       dead) — a backstop against a future regression that drops the call.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-breaker-timeout.ts
// ============================================================================
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
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
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Daemon breaker — wall-clock TIMEOUT carve-out (feature B)')
console.log('============================================================')

const { DaemonBreaker } = (await import('../../src/utils/daemonBreaker.js')) as typeof import('../../src/utils/daemonBreaker.js')

// ── 1. recordTimeout never feeds the consecutive trip ──────────────────────
section('recordTimeout(): N timeouts in a row stay CLOSED (vs recordResult ⇒ OPEN)')
{
  // A breaker that trips on 3 consecutive failures, rate effectively disabled.
  const mk = () => new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  const crash = mk()
  crash.recordResult(false); crash.recordResult(false)
  check('control: 3 consecutive recordResult(false) ⇒ OPEN', crash.recordResult(false) === 'open')

  const timeouts = mk()
  let st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  st = timeouts.recordTimeout()
  check('5 consecutive recordTimeout() ⇒ still CLOSED (no consecutive trip)', st === 'closed')
  check('breaker does NOT suppress firing after 5 timeouts', timeouts.shouldSuppressFire() === false)
  check('consecutiveFailures stays 0 across timeouts', timeouts.getStatus().consecutiveFailures === 0)
}

// ── 2. recordTimeout resets a primed consecutive streak ────────────────────
section('recordTimeout() RESETS a primed consecutive streak')
{
  const b = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  b.recordResult(false); b.recordResult(false) // 2 near-crashes, one short of the trip
  check('primed at 2 consecutive failures', b.getStatus().consecutiveFailures === 2)
  b.recordTimeout() // a long task lands — must NOT be the 3rd
  check('after a timeout the streak is reset to 0', b.getStatus().consecutiveFailures === 0)
  check('a 3rd real failure now ⇒ only 1, still CLOSED', b.recordResult(false) === 'closed')
}

// ── 3. window-rate backstop still trips on an all-timeout window ────────────
section('window-rate backstop: an ALL-timeout window still trips (wedged spawner)')
{
  // window 4, rate 0.75 ⇒ a full window of 4 timeouts (rate 1.0) must trip.
  const b = new DaemonBreaker({ consecutiveFails: 100, windowSize: 4, failureRate: 0.75, cooldownMs: 1000, now: () => 0 })
  b.recordTimeout(); b.recordTimeout(); b.recordTimeout()
  check('3 timeouts (window not full) ⇒ CLOSED', b.getState() === 'closed')
  check('4th timeout fills the window at rate 1.0 ⇒ OPEN (leash holds)', b.recordTimeout() === 'open')
}

// ── 4. the gate (default-off / opt-in) ─────────────────────────────────────
section('timeoutIsFleetFailure(): DEFAULT true (byte-identical), opt-in =1 ⇒ false')
{
  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  check('unset ⇒ timeout IS a fleet failure (today, byte-identical)', DaemonBreaker.timeoutIsFleetFailure() === true)
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  check('=1 ⇒ carve-out armed (timeout is NOT a fleet failure)', DaemonBreaker.timeoutIsFleetFailure() === false)
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '0'
  check('=0 ⇒ still a fleet failure (explicit old behavior)', DaemonBreaker.timeoutIsFleetFailure() === true)
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = 'yes'
  check('garbage ⇒ still a fleet failure (fail-safe)', DaemonBreaker.timeoutIsFleetFailure() === true)
  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}

// ── 5. END-TO-END: runTaskHeadless actually SETS timedOut, and the feed-site
//      branch routes that REAL result through the breaker correctly ─────────
section('END-TO-END: real runTaskHeadless sets timedOut:true on a wall-clock cap')
{
  const hr = (await import('../../src/daemon/headlessRun.js')) as typeof import('../../src/daemon/headlessRun.js')

  // A throwaway "child" that IGNORES SIGTERM and sleeps well past the cap, so the
  // REAL timer→SIGTERM→grace→SIGKILL path must fire and resolve timedOut:true.
  // runTaskHeadless spawns `node <process.argv[1]> -p <prompt>`; we point argv[1]
  // at this script and have it ignore its -p arg, so the spawn is self-contained
  // (no live mercury.mjs / API turn needed).
  const dir = mkdtempSync(join(tmpdir(), 'breaker-timeout-'))
  const childScript = join(dir, 'stubborn-child.mjs')
  writeFileSync(
    childScript,
    [
      "process.on('SIGTERM', () => {})", // refuse the polite kill ⇒ grace elapses ⇒ SIGKILL
      'setTimeout(() => process.exit(0), 60000)', // sleep 60s — far past the 200ms cap
    ].join('\n'),
  )

  const realArgv1 = process.argv[1]
  process.argv[1] = childScript // getSelfInvocation reads this live
  let res: import('../../src/daemon/headlessRun.js').HeadlessResult
  try {
    // 200ms cap, 150ms SIGTERM→SIGKILL grace ⇒ resolves in ~350ms.
    res = await hr.runTaskHeadless({ id: 'to-test', prompt: 'noop' }, dir, undefined, 200)
  } finally {
    process.argv[1] = realArgv1
  }
  check('runTaskHeadless resolved (never rejects)', res !== undefined)
  check('result.timedOut === true on a wall-clock cap (flag is LIVE)', res.timedOut === true)
  check('result.code === null (SIGKILLed)', res.code === null)

  // Feed THAT real result through the SAME branch the feed sites use.
  const feed = (r: import('../../src/daemon/headlessRun.js').HeadlessResult, b: InstanceType<typeof DaemonBreaker>) => {
    const failed = DaemonBreaker.isFailureExit(r.code)
    if (r.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) return b.recordTimeout()
    return b.recordResult(!failed)
  }

  const prev = process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK

  // DEFAULT (knob unset): the real timeout result trips the consecutive brake
  // exactly as today — byte-identical hard-failure feed.
  delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  const off = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, off); feed(res, off)
  check('DEFAULT: 3 real-timeout results ⇒ OPEN (byte-identical to today)', feed(res, off) === 'open')

  // OPT-IN (=1): the SAME real result no longer feeds the consecutive trip.
  process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = '1'
  const on = new DaemonBreaker({ consecutiveFails: 3, windowSize: 100, failureRate: 0.999, cooldownMs: 1000, now: () => 0 })
  feed(res, on); feed(res, on); feed(res, on); feed(res, on); feed(res, on)
  check('OPT-IN: 5 real-timeout results ⇒ still CLOSED (fleet not paused)', on.getState() === 'closed')

  if (prev === undefined) delete process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK
  else process.env.MERCURY_DAEMON_BREAKER_TIMEOUT_OK = prev
}

// ── 6. structural: the carve-out is WIRED at BOTH feed sites (not dead) ─────
section('structural: the one feed site calls the carve-out branch (wired, not inert)')
{
  const mainTs = src('daemon', 'main.ts')
  const rosterTs = src('daemon', 'roster.ts')
  const hrTs = src('daemon', 'headlessRun.ts')
  // The legacy engine died whole — roster.ts is the
  // ONE dispatch owner and the only breaker feed site; main.ts dispatches
  // nothing through runTaskHeadless directly any more.
  check('main.ts holds no direct runTaskHeadless dispatch (roster owns the feed)', !/await runTaskHeadless/.test(mainTs))
  check('roster.ts reads res.timedOut + calls recordTimeout', /res\.timedOut === true && !DaemonBreaker\.timeoutIsFleetFailure\(\)[\s\S]{0,120}recordTimeout\(\)/.test(rosterTs))
  check('headlessRun sets wasTimedOut on the cap timer', /wasTimedOut = true/.test(hrTs))
  check('headlessRun resolves timedOut:true when wasTimedOut', /wasTimedOut \? \{ timedOut: true \} : \{\}/.test(hrTs))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BREAKER-TIMEOUT PROOFS PASS')
else console.log(`❌ ${failures} BREAKER-TIMEOUT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
