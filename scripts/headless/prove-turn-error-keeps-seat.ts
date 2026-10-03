#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import { createTurnDriver, type TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally, removeWorld, user, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-turn-error-keeps-seat')
type Frame = Record<string, unknown>
const THROWN = 'the turn threw before its first request'
const labelOf = (f: Frame | undefined): string => (f === undefined ? 'none' : `${String(f.type)}${typeof f.state === 'string' ? `:${f.state}` : typeof f.status === 'string' ? `:${f.status}` : ''}`)
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const settleTicks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await tick()
}
const queued = (value: string, mode: 'prompt' | 'bash'): QueuedCommand => ({ value, mode, uuid: randomUUID() }) as QueuedCommand

console.log(' red on the base: §1 (the cycle catch wrote the envelope directly and shut the seat down with 1) and §5 (the seat ran an empty shell row as a turn that threw)')

type Rig = {
  queue: QueuedCommand[]
  executed: string[]
  out: Frame[]
  direct: Frame[]
  lifecycle: string[]
  shutdowns: number[]
  settles: number
  ports: TurnDriverPorts
}

function makeRig(): Rig {
  let shuttingDown = false
  const rig: Rig = { queue: [], executed: [], out: [], direct: [], lifecycle: [], shutdowns: [], settles: 0, ports: null as never }
  rig.ports = {
    dequeue: () => rig.queue.shift(),
    dequeueCommand: command => {
      const at = rig.queue.indexOf(command)
      return at < 0 ? undefined : rig.queue.splice(at, 1)[0]
    },
    peek: () => rig.queue[0],
    notifyLifecycle: (uuid, event) => {
      rig.lifecycle.push(`${uuid}:${event}`)
    },
    enqueueOutput: message => {
      rig.out.push(message as unknown as Frame)
    },
    writeDirect: async message => {
      rig.direct.push(message as unknown as Frame)
    },
    drainRows: () => [],
    executeTurn: async () => {},
    beforeCycle: async () => {},
    onTurnStart: () => {},
    turnIdOf: () => 'turn-rig',
    openTurnRow: messageIds => ({ type: 'turn', state: 'started', turn_id: 'turn-rig', message_ids: messageIds, model: 'rig', session_id: 'rig' }) as never,
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => false,
    hasHoldableBackgroundAgents: () => false,
    settleIdle: async () => {
      rig.settles++
      return 'stay'
    },
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => shuttingDown,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: error => ({ type: 'outcome', status: 'failed', error: { message: error instanceof Error ? error.message : String(error), class: 'internal' } }) as never,
    shutdown: code => {
      shuttingDown = true
      rig.shutdowns.push(code)
    },
    clock: { sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))) },
  }
  return rig
}

tally.section("§1 the driver: a throw inside a turn becomes that turn's result, and the seat drains the next command")
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.ports.executeTurn = async (command, _batch, onMessage) => {
    rig.executed.push(String(command.value))
    if (command.mode === 'bash') throw new Error(THROWN)
    onMessage({ type: 'outcome', status: 'completed', answer: 'answered' } as never)
  }
  const failing = queued('a turn that throws', 'bash')
  const next = queued('the next message', 'prompt')
  rig.queue.push(failing, next)
  driver.kick()
  await settleTicks(60)
  const labels = rig.out.map(labelOf).join(',')
  const refusalAt = rig.out.findIndex(f => f.type === 'outcome' && f.status === 'failed')
  const successAt = rig.out.findIndex(f => f.type === 'outcome' && f.status === 'completed')
  tally.check('the seat is not shut down', rig.shutdowns.length === 0, `shutdown(${rig.shutdowns.join(',')})`)
  tally.check("the refusal is the failed turn's result on the output road, never a direct write", refusalAt >= 0 && rig.direct.length === 0, `out=${labels} direct=${rig.direct.map(labelOf).join(',')}`)
  tally.check('the refusal carries the thrown words', refusalAt >= 0 && JSON.stringify(rig.out[refusalAt]).includes(THROWN), JSON.stringify(rig.out[refusalAt] ?? null))
  tally.check('the failed turn is framed like any turn: its turn row comes just before its outcome', refusalAt > 0 && labelOf(rig.out[refusalAt - 1]) === 'turn:started', labels)
  tally.check('the next command runs after the failed one', rig.executed.join(' | ') === 'a turn that throws | the next message', rig.executed.join(' | '))
  tally.check("the next command's result follows the refusal", refusalAt >= 0 && successAt > refusalAt, labels)
  tally.check("the failed turn's message completes like any turn's", rig.lifecycle.includes(`${String(failing.uuid)}:completed`) && rig.lifecycle.includes(`${String(next.uuid)}:completed`), rig.lifecycle.join(','))
  tally.check('the cycle settles idle as after an ordinary turn', driver.phase() === 'idle' && rig.settles >= 1, `phase=${driver.phase()} settles=${rig.settles}`)
}

tally.section('§2 the driver: a throw after the turn already answered still ends the seat, as before')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.ports.executeTurn = async (command, _batch, onMessage) => {
    rig.executed.push(String(command.value))
    onMessage({ type: 'outcome', status: 'completed', answer: 'answered' } as never)
    throw new Error(THROWN)
  }
  rig.queue.push(queued('answers, then throws', 'prompt'), queued('never reached', 'bash'))
  driver.kick()
  await settleTicks(60)
  tally.check('shutdown(1), once', rig.shutdowns.join(',') === '1', `shutdown(${rig.shutdowns.join(',')})`)
  tally.check('the refusal goes out on the direct write', rig.direct.length === 1 && rig.direct[0]?.status === 'failed', rig.direct.map(labelOf).join(','))
  tally.check('no later command runs', rig.executed.join(' | ') === 'answers, then throws', rig.executed.join(' | '))
}

tally.section('§3 the driver: when the refusal itself cannot be written, the seat still ends with 1')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.ports.enqueueOutput = message => {
    if ((message as { status?: unknown }).status === 'failed') throw new Error('the output is gone')
    rig.out.push(message as unknown as Frame)
  }
  rig.ports.executeTurn = async command => {
    rig.executed.push(String(command.value))
    throw new Error(THROWN)
  }
  rig.queue.push(queued('throws, and its refusal cannot be written', 'bash'), queued('never reached', 'prompt'))
  driver.kick()
  await settleTicks(60)
  tally.check('shutdown(1), once', rig.shutdowns.join(',') === '1', `shutdown(${rig.shutdowns.join(',')})`)
  tally.check('no later command runs', rig.executed.join(' | ') === 'throws, and its refusal cannot be written', rig.executed.join(' | '))
}

tally.section('§4 the driver: an ordinary turn keeps its frames, their order and its road')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.ports.executeTurn = async (command, _batch, onMessage) => {
    rig.executed.push(String(command.value))
    onMessage({ type: 'turn', state: 'started' } as never)
    onMessage({ type: 'text' } as never)
    onMessage({ type: 'outcome', status: 'completed' } as never)
  }
  const ordinary = queued('an ordinary turn', 'prompt')
  rig.queue.push(ordinary)
  driver.kick()
  await settleTicks(60)
  tally.check('turn row, text, outcome: in that order, nothing minted', rig.out.map(labelOf).join(',') === 'turn:started,text,outcome:completed', rig.out.map(labelOf).join(','))
  tally.check('no direct write and no shutdown', rig.direct.length === 0 && rig.shutdowns.length === 0, `direct=${rig.direct.length} shutdown(${rig.shutdowns.join(',')})`)
  tally.check('its message starts and completes', rig.lifecycle.join(',') === `${String(ordinary.uuid)}:started,${String(ordinary.uuid)}:completed`, rig.lifecycle.join(','))
}

tally.section('§5 the seat, on the built product: a row with nothing in it is refused at the door, the seat answers the next message, and stdin close still ends it with 0')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist; §1-§4 above still ran`)
} else {
  console.log(`build under proof: ${DIST}`)
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'turn-error-keeps-seat-')))
  const runHome = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(runHome, cwd)
  const NEXT_ASK = 'after the failed turn, answer this'
  const NEXT_ANSWER = 'answered after the failed turn'
  const script: Script = req => (req.ask.includes(NEXT_ASK) ? [{ type: 'text', text: NEXT_ANSWER }] : [{ type: 'text', text: 'noted' }])
  const fixture = await startScriptedFixture(script)
  const runner = bootRunner({ cwd, env: childEnv(runHome, Number(new URL(fixture.base).port)) })
  runner.proc.stdin?.on('error', () => {})

  const refused = await runner.door.send({ type: 'user', mode: 'bash', message: { role: 'user', content: [] }, uuid: randomUUID(), session_id: '' })
  await sleep(300)
  tally.check('a shell row with no command is refused at the door (queue/add answers invalid params), and no turn opens', refused === false && !runner.frames.some(isOutcome), runner.frames.map(labelOf).join(' · '))

  const before = runner.frames.length
  runner.send(user(NEXT_ASK, randomUUID()))
  const next = await Promise.race([
    runner.waitFor("the next message's outcome", f => isOutcome(f) && f.status === 'completed', bound(60_000), before),
    runner.exited.then(() => null),
  ])
  tally.check('the seat is still alive after the failed turn', runner.proc.exitCode === null, `exit code ${String(runner.proc.exitCode)}`)
  tally.check('the next user message is answered', next !== null && String(next.answer ?? '').includes(NEXT_ANSWER) && fixture.requests.some(r => r.ask.includes(NEXT_ASK)), JSON.stringify(next).slice(0, 240))

  await runner.stop(bound(15_000))
  const code = await runner.exited
  tally.check('stdin close ends the seat with exit 0', code === 0, `exit ${String(code)}`)
  await fixture.close()
  console.log(`  timeline: ${runner.frames.map(labelOf).join(' · ')}`)
  const stderr = runner.stderr().trim()
  if (stderr !== '') console.log(`  stderr tail: ${stderr.split('\n').slice(-2).join(' | ').slice(0, 240)}`)
  await removeWorld(root)
}
tally.finish()
