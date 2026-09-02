#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-driver-settle-race.ts — THE SETTLE-INSTANT
//  DELIVERY LAW on the headless turn driver (delivery-verifier lane).
//
//  The delivery law: a message submitted to a live session is delivered at
//  the next legal protocol boundary, exactly once. The driver's kick() is a
//  mutex — it no-ops unless the phase is 'idle' — and the post-cycle queue
//  recheck closes the "arrived while a turn ran" stranding window. These
//  legs attack the OTHER window: the settle instant itself.
//
//    R1  THE SETTLE-INSTANT STRAND — a command that arrives (enqueue +
//        kick) DURING the awaited settleIdle() finds the phase
//        'settling_idle': the kick no-ops, and a 'stay' verdict used to
//        return with no queue recheck — the command stranded until the
//        next unrelated stimulus. For a team-lead session, settleIdle
//        loops on the MAILBOX for as long as teammates exist, so the
//        strand was unbounded. The law: after settleIdle settles 'stay',
//        anything queued drains at once.
//    R2  THE RUNNING-WINDOW RECHECK (control) — a command arriving while
//        a turn runs is drained by the post-cycle recheck (the pinned
//        pre-existing law; the fix must not disturb it).
//    R3  'reenter' drains newly queued work (pre-existing law).
//    R4  EXACTLY-ONCE — across every leg, no command's turn runs twice.
//    R5  'close' closes the output exactly once, even when kicked after.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-driver-settle-race.ts
// ============================================================================
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import { createTurnDriver, type TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — driver-settle-race prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function settleTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

type Rig = {
  queue: QueuedCommand[]
  executed: string[]
  closes: number
  ports: TurnDriverPorts
  settleIdleImpl: () => Promise<'reenter' | 'close' | 'stay'>
}

function makeRig(): Rig {
  const rig: Rig = {
    queue: [],
    executed: [],
    closes: 0,
    settleIdleImpl: async () => 'stay',
    ports: null as never,
  }
  rig.ports = {
    dequeue: () => rig.queue.shift(),
    peek: () => rig.queue[0],
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainSdkEvents: () => [],
    flushInternalEvents: async () => {},
    executeTurn: async command => {
      rig.executed.push(String(command.value))
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => false,
    hasHoldableBackgroundAgents: () => false,
    takePendingSuggestion: () => null,
    settleIdle: () => rig.settleIdleImpl(),
    closeOutput: async () => {
      rig.closes++
    },
    notifySessionState: () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: () => ({ type: 'result' }) as never,
    shutdown: () => {},
    clock: { sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))) },
  }
  return rig
}

const cmd = (value: string): QueuedCommand => ({ value, mode: 'prompt' }) as QueuedCommand

// ── R1 — the settle-instant strand ──────────────────────────────────────────
section("R1 — a command arriving DURING settleIdle drains after 'stay'")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  let settleCalls = 0
  rig.settleIdleImpl = async () => {
    settleCalls++
    if (settleCalls === 1) {
      // The settle instant: the frame arrives while settleIdle awaits —
      // exactly the phase window where kick() reads 'settling_idle' and
      // no-ops. (print.ts's stdin loop does exactly this: enqueue + kick.)
      await tick()
      rig.queue.push(cmd('arrived at the settle instant'))
      driver.kick()
      await tick()
    }
    return 'stay'
  }
  rig.queue.push(cmd('first turn'))
  driver.kick()
  await settleTicks(40)
  check('the first turn ran', rig.executed.includes('first turn'), JSON.stringify(rig.executed))
  check(
    "the settle-instant command DRAINED (the strand: kick no-oped in 'settling_idle' and 'stay' never rechecked the queue)",
    rig.executed.includes('arrived at the settle instant'),
    `executed=${JSON.stringify(rig.executed)} queue=${rig.queue.length}`,
  )
  check('exactly once', rig.executed.filter(v => v === 'arrived at the settle instant').length <= 1)
}

// ── R2 — the running-window recheck (control) ───────────────────────────────
section('R2 — a command arriving while a turn RUNS drains via the post-cycle recheck')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  let injected = false
  rig.ports.executeTurn = async command => {
    rig.executed.push(String(command.value))
    if (!injected) {
      injected = true
      rig.queue.push(cmd('arrived mid-turn'))
      driver.kick() // no-ops: the phase is not idle
    }
    await tick()
  }
  rig.queue.push(cmd('first turn'))
  driver.kick()
  await settleTicks(40)
  check('the mid-turn command drained (the pinned running-window law)', rig.executed.includes('arrived mid-turn'), JSON.stringify(rig.executed))
  check('exactly once', rig.executed.filter(v => v === 'arrived mid-turn').length === 1)
}

// ── R3 — 'reenter' drains newly queued work ─────────────────────────────────
section("R3 — settleIdle 'reenter' drains the work it queued")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  let settleCalls = 0
  rig.settleIdleImpl = async () => {
    settleCalls++
    if (settleCalls === 1) {
      rig.queue.push(cmd('mailbox turn'))
      return 'reenter'
    }
    return 'stay'
  }
  rig.queue.push(cmd('first turn'))
  driver.kick()
  await settleTicks(40)
  check("the 'reenter' work ran", rig.executed.includes('mailbox turn'), JSON.stringify(rig.executed))
  check('exactly once', rig.executed.filter(v => v === 'mailbox turn').length === 1)
}

// ── R4 — exactly-once across a settle-instant arrival + a later kick ────────
section('R4 — the settle-instant command never runs twice')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  let settleCalls = 0
  rig.settleIdleImpl = async () => {
    settleCalls++
    if (settleCalls === 1) {
      rig.queue.push(cmd('exactly once'))
      driver.kick()
    }
    return 'stay'
  }
  rig.queue.push(cmd('first turn'))
  driver.kick()
  await settleTicks(40)
  // A later external kick with an empty queue must not re-run anything.
  driver.kick()
  await settleTicks(20)
  check('the settle-instant command ran exactly once', rig.executed.filter(v => v === 'exactly once').length === 1, JSON.stringify(rig.executed))
}

// ── R5 — 'close' still closes exactly once ──────────────────────────────────
section("R5 — 'close' closes the output exactly once")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.settleIdleImpl = async () => 'close'
  rig.queue.push(cmd('final turn'))
  driver.kick()
  await settleTicks(40)
  await driver.closeOutputOnce()
  check('output closed exactly once', rig.closes === 1, String(rig.closes))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`DRIVER-SETTLE-RACE: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`DRIVER-SETTLE-RACE: all ${checks} checks passed`)
process.exit(0)
