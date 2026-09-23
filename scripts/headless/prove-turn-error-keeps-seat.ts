#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import { createTurnDriver, type TurnDriverPorts } from '../../src/cli/headless/turnDriver.ts'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, removeWorld, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-turn-error-keeps-seat')
type Frame = Record<string, unknown>
const THROWN = 'the turn threw before its first request'
const labelOf = (f: Frame | undefined): string => (f === undefined ? 'none' : `${String(f.type)}${typeof f.subtype === 'string' ? `:${f.subtype}` : ''}`)
const errorsOf = (f: Frame | null): string[] => (f !== null && Array.isArray(f.errors) ? (f.errors as unknown[]).map(String) : [])
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const settleTicks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await tick()
}
const queued = (value: string, mode: 'prompt' | 'bash'): QueuedCommand => ({ value, mode, uuid: randomUUID() }) as QueuedCommand

console.log(' red on the base: §1 (the cycle catch wrote the envelope directly and shut the seat down with 1) and §5 (the seat exited on the failed turn)')

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
    drainSdkEvents: () => [],
    executeTurn: async () => {},
    beforeCycle: async () => {},
    onTurnStart: () => ({ type: 'system', subtype: 'turn_started' }) as never,
    onTurnSettled: () => {},
    hasWaitableBackgroundTasks: () => false,
    hasHoldableBackgroundAgents: () => false,
    takePendingSuggestion: () => null,
    settleIdle: async () => {
      rig.settles++
      return 'stay'
    },
    closeOutput: async () => {},
    notifySessionState: () => {},
    isShuttingDown: () => shuttingDown,
    idleTimerStop: () => {},
    idleTimerStart: () => {},
    onCycleError: error => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error instanceof Error ? error.message : String(error)] }) as never,
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
    onMessage({ type: 'result', subtype: 'success', is_error: false, result: 'answered' } as never)
  }
  const failing = queued('a turn that throws', 'bash')
  const next = queued('the next message', 'prompt')
  rig.queue.push(failing, next)
  driver.kick()
  await settleTicks(60)
  const labels = rig.out.map(labelOf).join(',')
  const refusalAt = rig.out.findIndex(f => f.type === 'result' && f.is_error === true && f.subtype === 'error_during_execution')
  const successAt = rig.out.findIndex(f => f.type === 'result' && f.subtype === 'success')
  tally.check('the seat is not shut down', rig.shutdowns.length === 0, `shutdown(${rig.shutdowns.join(',')})`)
  tally.check("the refusal is the failed turn's result on the output road, never a direct write", refusalAt >= 0 && rig.direct.length === 0, `out=${labels} direct=${rig.direct.map(labelOf).join(',')}`)
  tally.check('the refusal carries the thrown words', refusalAt >= 0 && JSON.stringify(rig.out[refusalAt]).includes(THROWN), JSON.stringify(rig.out[refusalAt] ?? null))
  tally.check('the failed turn is framed like any turn: its open edge comes just before its result', refusalAt > 0 && labelOf(rig.out[refusalAt - 1]) === 'system:turn_started', labels)
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
    onMessage({ type: 'result', subtype: 'success', is_error: false, result: 'answered' } as never)
    throw new Error(THROWN)
  }
  rig.queue.push(queued('answers, then throws', 'prompt'), queued('never reached', 'bash'))
  driver.kick()
  await settleTicks(60)
  tally.check('shutdown(1), once', rig.shutdowns.join(',') === '1', `shutdown(${rig.shutdowns.join(',')})`)
  tally.check('the refusal goes out on the direct write', rig.direct.length === 1 && rig.direct[0]?.is_error === true, rig.direct.map(labelOf).join(','))
  tally.check('no later command runs', rig.executed.join(' | ') === 'answers, then throws', rig.executed.join(' | '))
}

tally.section('§3 the driver: when the refusal itself cannot be written, the seat still ends with 1')
{
  const rig = makeRig()
  const driver = createTurnDriver(rig.ports)
  rig.ports.enqueueOutput = message => {
    if ((message as { is_error?: unknown }).is_error === true) throw new Error('the output is gone')
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
    onMessage({ type: 'assistant' } as never)
    onMessage({ type: 'result', subtype: 'success', is_error: false } as never)
  }
  const ordinary = queued('an ordinary turn', 'prompt')
  rig.queue.push(ordinary)
  driver.kick()
  await settleTicks(60)
  tally.check('assistant, open edge, result: in that order', rig.out.map(labelOf).join(',') === 'assistant,system:turn_started,result:success', rig.out.map(labelOf).join(','))
  tally.check('no direct write and no shutdown', rig.direct.length === 0 && rig.shutdowns.length === 0, `direct=${rig.direct.length} shutdown(${rig.shutdowns.join(',')})`)
  tally.check('its message starts and completes', rig.lifecycle.join(',') === `${String(ordinary.uuid)}:started,${String(ordinary.uuid)}:completed`, rig.lifecycle.join(','))
}

tally.section('§5 the seat, on the built product: a turn that throws answers with an error result, the seat answers the next message, and stdin close still ends it with 0')
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

  runner.send({ type: 'user', mode: 'bash', message: { role: 'user', content: [] }, uuid: randomUUID(), session_id: '' })
  const failed = await runner.waitFor("the failed turn's result", isResult, bound(60_000))
  const errors = errorsOf(failed)
  tally.check('a bash-mode frame with no text throws inside its turn, and the seat writes a result frame', failed !== null, runner.frames.map(labelOf).join(' · '))
  tally.check('that result is is_error true with subtype error_during_execution', failed?.is_error === true && failed?.subtype === 'error_during_execution', JSON.stringify(failed).slice(0, 240))
  tally.check('it names the thrown words', errors.some(e => e.includes('requires string input')), errors.join(' | ').slice(0, 240))

  const before = runner.frames.length
  runner.send(user(NEXT_ASK, randomUUID()))
  const next = await Promise.race([
    runner.waitFor("the next message's result", f => isResult(f) && f.subtype === 'success', bound(60_000), before),
    runner.exited.then(() => null),
  ])
  tally.check('the seat is still alive after the failed turn', runner.proc.exitCode === null, `exit code ${String(runner.proc.exitCode)}`)
  tally.check('the next user message is answered', next !== null && String(next.result ?? '').includes(NEXT_ANSWER) && fixture.requests.some(r => r.ask.includes(NEXT_ASK)), JSON.stringify(next).slice(0, 240))

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
