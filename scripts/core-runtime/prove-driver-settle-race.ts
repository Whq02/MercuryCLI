#!/usr/bin/env bun
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

section("R1 — a command arriving DURING settleIdle drains after 'stay'")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  let settleCalls = 0
  rig.settleIdleImpl = async () => {
    settleCalls++
    if (settleCalls === 1) {
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
      driver.kick()
    }
    await tick()
  }
  rig.queue.push(cmd('first turn'))
  driver.kick()
  await settleTicks(40)
  check('the mid-turn command drained (the pinned running-window law)', rig.executed.includes('arrived mid-turn'), JSON.stringify(rig.executed))
  check('exactly once', rig.executed.filter(v => v === 'arrived mid-turn').length === 1)
}

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
  driver.kick()
  await settleTicks(20)
  check('the settle-instant command ran exactly once', rig.executed.filter(v => v === 'exactly once').length === 1, JSON.stringify(rig.executed))
}

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
