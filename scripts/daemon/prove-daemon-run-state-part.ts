#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-state-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — change makeDaemonRunState or markDaemonReady in src/daemon/run/state.ts so the state matches the label` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const { makeDaemonRunState, markDaemonReady } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')
const breaker = new DaemonBreaker()
const facts = { dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker, maxInflight: 7, controlEnabled: true }

section('§1 the state as the boot makes it: the facts it was handed, and nothing taken yet')
{
  const before = Date.now()
  const state = makeDaemonRunState(facts)
  const after = Date.now()
  check('the facts of the boot are carried as they were handed over', state.dir === home && state.bootBuildTree === 'aaaaaaaaaaaa' && state.foreground === false && state.breaker === breaker && state.maxInflight === 7 && state.controlEnabled === true)
  check('the start is stamped when the state is made', state.startedAt >= before && state.startedAt <= after, `${before} ≤ ${state.startedAt} ≤ ${after}`)
  check('nothing is served, armed or held yet', state.controlServer === null && state.stopPlaneHeal === null && state.stopArmedBeat === null && state.stopLockBeat === null && state.stopSessionlessBeat === null && state.stopSaturnTicker === null && state.stopHostJobs === null && state.ownerWatch === undefined && state.ownerPipe === undefined)
  check('no restart is armed or standing, the teardown has not run, the daemon is not ready', state.restartArmed === false && state.restartAfterTeardown === false && state.teardownComplete === false && state.ready === false)
  let threw = false
  try {
    state.releaseHeldReading()
  } catch {
    threw = true
  }
  check('letting go of a reading that was never held does nothing', !threw)
}

section('§2 what the state reads from the environment it reads once, when it is made')
{
  const plain = makeDaemonRunState(facts)
  process.env.MERCURY_DAEMON_PERSIST = '1'
  const persistent = makeDaemonRunState(facts)
  delete process.env.MERCURY_DAEMON_PERSIST
  check('a daemon persists when the switch says so at its boot', plain.persist === false && persistent.persist === true)
  check('the switch moving later does not move a state already made', persistent.persist === true && makeDaemonRunState(facts).persist === false)
}

section('§3 readiness: one flip that sets the flag and wakes whoever waits on it')
{
  const state = makeDaemonRunState(facts)
  let woke = 0
  void state.readyPromise.then(() => {
    woke++
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  check('before the flip the daemon reads not ready and the wait is not answered', state.ready === false && woke === 0)
  markDaemonReady(state)
  const flagAtOnce = state.ready
  await Promise.resolve()
  check('the flip sets the flag at once and answers the wait in the same turn', flagAtOnce === true && woke === 1)
  markDaemonReady(state)
  await Promise.resolve()
  check('a second flip changes nothing', state.ready === true && woke === 1)
}

section('§4 one state per daemon: two states share nothing')
{
  const one = makeDaemonRunState(facts)
  const two = makeDaemonRunState(facts)
  one.restartArmed = true
  one.teardownComplete = true
  one.stopArmedBeat = () => {}
  markDaemonReady(one)
  check('what one daemon arms, marks or takes is not seen by another', two.restartArmed === false && two.teardownComplete === false && two.stopArmedBeat === null && two.ready === false && one.readyPromise !== two.readyPromise)
}

rmSync(home, { recursive: true, force: true })
console.log(`\nprove-daemon-run-state-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
