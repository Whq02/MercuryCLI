#!/usr/bin/env bun
import '../lib/hermetic.ts'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'

const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.ts')
type TurnDriverPorts = Parameters<typeof createTurnDriver>[0]

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 500) : ''}`)
  if (!cond) failures++
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await tick() }

const BAND: Record<string, number> = { now: 0, next: 1, later: 2 }
type Turn = { command: QueuedCommand; batch: QueuedCommand[]; initialNotices: QueuedCommand[] }
type Rig = { queue: QueuedCommand[]; turns: Turn[]; ports: TurnDriverPorts }
function makeRig(): Rig {
  const rig: Rig = { queue: [], turns: [], ports: null as never }
  const headIndex = (): number => {
    let best = -1
    for (let i = 0; i < rig.queue.length; i++) {
      if (best === -1 || BAND[rig.queue[i]!.priority ?? 'next']! < BAND[rig.queue[best]!.priority ?? 'next']!) best = i
    }
    return best
  }
  rig.ports = {
    dequeue: () => { const at = headIndex(); return at < 0 ? undefined : rig.queue.splice(at, 1)[0] },
    dequeueCommand: command => { const at = rig.queue.indexOf(command); return at < 0 ? undefined : rig.queue.splice(at, 1)[0] },
    peek: () => { const at = headIndex(); return at < 0 ? undefined : rig.queue[at] },
    notifyLifecycle: () => {},
    enqueueOutput: () => {},
    writeDirect: async () => {},
    drainRows: () => [],
    executeTurn: async (command, batch, _onMessage, initialNotices) => {
      rig.turns.push({ command, batch, initialNotices: initialNotices ?? [] })
      await tick()
    },
    beforeCycle: async () => {},
    onTurnStart: () => {},
    turnIdOf: () => 't-rig',
    openTurnRow: () => ({ type: 'turn', state: 'started', turn_id: 't-rig' }) as never,
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => false,
    hasHoldableBackgroundAgents: () => false,
    waitableBackgroundTaskCount: () => 0,
    settleIdle: async () => 'stay',
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => false,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: () => ({ type: 'outcome', status: 'failed' }) as never,
    shutdown: () => {},
    clock: { sleep: async () => {}, now: () => 0 },
    queuedMainThread: () => rig.queue,
  } as TurnDriverPorts
  return rig
}
let seq = 0
const stopNotice = (name: string): QueuedCommand => ({
  value: `<task-notification><task-id>${name}</task-id><status>stopped</status><summary>${name} was stopped — the session's runner restarted after a relaunch before it finished</summary></task-notification>`,
  mode: 'task-notification',
  priority: 'later',
  queueId: `q${++seq}`,
  uuid: `u${seq}`,
}) as QueuedCommand
const prompt = (text: string, priority: 'now' | 'next' | 'later' = 'next'): QueuedCommand => ({ value: text, mode: 'prompt', priority, queueId: `q${++seq}`, uuid: `u${seq}` }) as QueuedCommand
const idOf = (c: QueuedCommand): string => /<task-id>(.*?)<\/task-id>/.exec(String(c.value))?.[1] ?? String(c.value)

console.log("a crewmate's stop notice already queued when the operator's prompt is taken rides that prompt's turn (RELEASE-30-AIR R30A-08)")

console.log("\n§1 the Air's order: the stop notice (later band, queued at the park and again at the resume) then the prompt")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(stopNotice('sleeper8b'), prompt('No tools. Is the crewmate sleeper8b still running? One line.'))
  driver.kick()
  await settle(12)
  check('one turn ran, the prompt\'s', rig.turns.length === 1 && rig.turns[0]!.command.mode === 'prompt', JSON.stringify(rig.turns.map(t => t.command.mode)))
  check("the stop notice rides the prompt's turn as an initial notice — delivered before the request leaves, never a turn of its own after the answer", rig.turns[0]?.initialNotices.map(idOf).join(',') === 'sleeper8b', JSON.stringify(rig.turns[0]?.initialNotices.map(idOf)))
  check('the queue is empty after the turn', rig.queue.length === 0)
}

console.log('\n§2 several notices, one prompt: all of them ride; the prompt is still the turn')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(stopNotice('alpha'), stopNotice('beta'), prompt('what happened?'))
  driver.kick()
  await settle(12)
  check('one turn, both notices on it in queue order', rig.turns.length === 1 && rig.turns[0]!.initialNotices.map(idOf).join(',') === 'alpha,beta', JSON.stringify(rig.turns.map(t => t.initialNotices.map(idOf))))
}

console.log('\n§3 a notice alone is still its own turn; a notice queued after the prompt was taken waits for the next turn')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(stopNotice('solo'))
  driver.kick()
  await settle(12)
  check('a notice with no operator words runs as its own notification turn', rig.turns.length === 1 && rig.turns[0]!.command.mode === 'task-notification' && rig.turns[0]!.initialNotices.length === 0, JSON.stringify(rig.turns.map(t => t.command.mode)))
  rig.turns.length = 0
  rig.queue.push(prompt('go'))
  driver.kick()
  await settle(12)
  check('a prompt with nothing queued carries no notice', rig.turns.length === 1 && rig.turns[0]!.initialNotices.length === 0)
}

console.log('\n§4 a hold released on an idle driver changes nothing: the queued notice still rides the next operator words')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.queue.push(stopNotice('held'))
  driver.releaseHold()
  rig.queue.push(prompt('and now?'))
  driver.kick()
  await settle(12)
  check('the notice rides the operator\'s next turn', rig.turns.length === 1 && rig.turns[0]!.command.mode === 'prompt' && rig.turns[0]!.initialNotices.map(idOf).join(',') === 'held', JSON.stringify(rig.turns.map(t => [t.command.mode, t.initialNotices.map(idOf)])))
}

console.log(`\n${failures === 0 ? '✅ a queued notice rides the next prompt — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
