#!/usr/bin/env bun
import { mock } from 'bun:test'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const failHint = cond ? '' : ' | to fix: the rounds, pauses, spawn guard and heal order live in ensureOwnedDaemon in src/daemon/switchboard/ensureDaemon.ts; compare the walked steps above with the wanted ladder named in the label'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${failHint}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

type Verdict = { state: string; daemon: { pid: number | null; ownerPid: number | null } | null }
type Hold = 'clear' | 'stopping' | 'held'
const verdict = (state: string, pid: number | null = null): Verdict => ({ state, daemon: pid === null ? null : { pid, ownerPid: null } })

const world = { trace: [] as string[], verdicts: [] as Verdict[], rest: verdict('absent'), holds: [] as Hold[], spawns: 0 }
const begin = (verdicts: Verdict[], rest: Verdict, holds: Hold[] = []): void => {
  world.trace = []
  world.verdicts = verdicts
  world.rest = rest
  world.holds = holds
  world.spawns = 0
}

const handshake = await import('../../src/daemon/control/handshake.ts')
const ownedDaemon = await import('../../src/daemon/control/ownedDaemon.ts')
const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const pidLock = await import('../../src/platform/substrate/pidLock.ts')
const standdown = await import('../../src/daemon/control/daemonStanddown.ts')
const presence = await import('../../src/daemon/switchboard/screenPresence.ts')

mock.module('../../src/daemon/control/handshake.ts', () => ({
  ...handshake,
  handshakeDaemon: async (opts: { timeoutMs?: number } = {}) => {
    world.trace.push(`hello ${opts.timeoutMs}`)
    return world.verdicts.shift() ?? world.rest
  },
  handoverInFlightFor: () => false,
  healDaemonVersion: async () => {
    world.trace.push('heal')
    return { state: 'restarting' }
  },
}))
mock.module('../../src/daemon/control/ownedDaemon.ts', () => ({
  ...ownedDaemon,
  armDaemonSignInPoke: () => {},
  adoptOwnedDaemonPid: () => {},
  spawnOwnedDaemon: () => {
    world.trace.push('spawn')
    world.spawns++
    return 5151
  },
}))
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...controlSocket,
  daemonLastUnreachableAt: () => 0,
  readDaemonState: async () => {
    const hold = world.holds.shift() ?? 'clear'
    world.trace.push(`plane ${hold}`)
    return hold === 'clear' ? null : { pid: 4242, ...(hold === 'stopping' ? { state: 'stopping' } : {}) }
  },
}))
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({ ...ownerWatch, isProcessAlive: () => true }))
mock.module('../../src/platform/substrate/pidLock.ts', () => ({ ...pidLock, probePidLock: async () => null }))
mock.module('../../src/daemon/control/daemonStanddown.ts', () => ({ ...standdown, daemonHaltStanddownActive: () => false }))
mock.module('../../src/daemon/switchboard/screenPresence.ts', () => ({ ...presence, startScreenPresenceBeat: () => false }))

const ensure = await import('../../src/daemon/switchboard/ensureDaemon.ts')

const pause = async (ms: number): Promise<void> => {
  world.trace.push(`pause ${ms}`)
}
const door = async (): Promise<boolean> => ensure.ensureOwnedDaemon({ sleep: pause })
const walked = (): string => world.trace.join(', ')
const same = (want: string[]): boolean => world.trace.length === want.length && want.every((step, i) => world.trace[i] === step)
const round = ['hello 500', 'pause 250']

section('1. a daemon that says it is starting and never answers: the ladder walks its whole bound')
{
  ensure._resetDaemonUsableMemoForProofs()
  ensure._setDaemonLadderRoundsForProofs(null)
  begin([], verdict('starting'))
  const answer = await door()
  const want = ['hello 500', ...Array.from({ length: 40 }, () => round).flat()]
  check('the door asks once, then the ladder runs 40 rounds, each a hello bounded at 500 ms and then a pause of 250 ms, in that order', same(want), `${world.trace.length} steps, ${want.length} wanted: ${walked()}`)
  check('it answers false and spawns nothing beside the daemon that holds the pipe', answer === false && world.spawns === 0, `answer ${answer}, spawns ${world.spawns}`)
}

section('2. two doors at once beside a starting daemon ride one ladder')
{
  ensure._resetDaemonUsableMemoForProofs()
  ensure._setDaemonLadderRoundsForProofs(3)
  begin([], verdict('starting'))
  const answers = await Promise.all([door(), door()])
  const want = ['hello 500', 'hello 500', ...round, ...round, ...round]
  check('each door asks once and the three rounds are walked once, not once for each door', same(want), walked())
  check('both doors take the one answer', answers.join() === 'false,false' && world.spawns === 0, `answers ${answers.join()}, spawns ${world.spawns}`)
}

section('3. the starting daemon leaves while the ladder waits: the door is entered again and spawns through its one guard')
{
  ensure._resetDaemonUsableMemoForProofs()
  ensure._setDaemonLadderRoundsForProofs(6)
  begin([verdict('starting'), verdict('starting'), verdict('absent'), verdict('absent'), verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151), ['clear', 'clear'])
  const answer = await door()
  const want = ['hello 500', ...round, 'hello 500', 'plane clear', 'hello 500', 'plane clear', 'spawn', ...round, 'hello 500']
  check('one round waits on the starting daemon, the next finds it absent with the plane clear, the door asks again, finds the plane clear, spawns once, and waits a round of 250 ms for the new daemon', same(want), walked())
  check('it answers true after the one spawn', answer === true && world.spawns === 1, `answer ${answer}, spawns ${world.spawns}`)
}

section('4. a plane still held by a daemon on its way out: the spawn waits for the plane to clear')
{
  ensure._resetDaemonUsableMemoForProofs()
  ensure._setDaemonLadderRoundsForProofs(6)
  begin([verdict('absent'), verdict('absent'), verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151), ['held', 'stopping', 'clear'])
  const answer = await door()
  const want = ['hello 500', 'plane held', ...round, 'plane stopping', 'pause 250', 'plane clear', 'spawn', ...round, 'hello 500']
  check('a held plane is asked for a hello and waited 250 ms, a stopping one is waited 250 ms with no hello, the clear one is spawned into, and the new daemon is waited a round of 250 ms', same(want), walked())
  check('it answers true after the one spawn', answer === true && world.spawns === 1, `answer ${answer}, spawns ${world.spawns}`)
  ensure._resetDaemonUsableMemoForProofs()
  begin([verdict('absent'), verdict('matched', 4242)], verdict('matched', 4242), ['held'])
  const kept = await door()
  check('a held plane whose daemon answers is used as it is: no pause and no spawn', kept === true && world.spawns === 0 && same(['hello 500', 'plane held', 'hello 500']), walked())
}

section('5. an older daemon that restarts itself: the door waits for the successor')
{
  ensure._resetDaemonUsableMemoForProofs()
  ensure._setDaemonLadderRoundsForProofs(6)
  begin([verdict('older', 100), verdict('older', 100), verdict('matched', 200)], verdict('matched', 200))
  const answer = await door()
  const want = ['hello 500', 'heal', ...round, 'hello 500']
  check('the heal is asked once, the same pid is waited 250 ms, and the new pid is taken', same(want), walked())
  check('it answers true and spawns nothing', answer === true && world.spawns === 0, `answer ${answer}, spawns ${world.spawns}`)
}

ensure._setDaemonLadderRoundsForProofs(null)
console.log(failures === 0 ? '\nprove-ensure-daemon-ladder: green' : `\nprove-ensure-daemon-ladder: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
