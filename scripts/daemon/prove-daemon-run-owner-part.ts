#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-owner-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
process.env.MERCURY_DAEMON_OWNER_PID = '4242'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — the value above is what the part did; change src/daemon/run/owner.ts (armOwnerWatch, makeSessionlessBeat and the owner handover around them) until it does what the label says` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

type Receipt = { parked: string[]; draining: string[]; released: string[]; skipped: string[]; refused: string[] }
type WatchOptions = { ownerPid: number; baselineToken: unknown; log: (line: string) => void; onOrphan: (why: string) => void }
const said: string[] = []
const seen: Array<{ call: string; args: unknown[] }> = []
const script = {
  now: 1_000_000,
  receipt: { parked: ['concourse-w1'], draining: [], released: [], skipped: [], refused: [] } as Receipt,
  nextOwner: (_departing: number | null, _dir?: string, _since?: number): number | undefined => undefined,
  pending: (): string[] => [],
  records: {} as Record<string, { sessionId: string; endedAt?: number; schedules?: unknown[]; heldFires?: unknown[] }>,
  token: (_pid: number): Promise<string> => Promise.resolve('the-baseline'),
  ownerFd: null as number | null,
  pipeArmed: true,
  alive: (_pid: number): boolean => true,
  record: { pid: process.pid, ownerPid: 4242, startToken: 'the-token-of-the-boot', startedAt: 1 } as { pid: number; ownerPid: number; startToken?: string; startedAt?: number } | null,
  ceilingMs: 2500,
}
const watches: Array<{ options: WatchOptions; stopped: boolean; pipeClosed: number }> = []
const pipes: Array<{ fd: number; onClosed: () => void; closed: boolean }> = []
const note = (call: string, args: unknown[]): void => void seen.push({ call, args })

const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const idleRetirement = await import('../../src/daemon/control/idleRetirement.ts')
const sleepDoor = await import('../../src/platform/async/sleep.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...workers,
  parkAllConcourseSessions: (...args: unknown[]) => {
    note('parkAll', args)
    return script.receipt
  },
  nextLiveCockpitOwner: (departing: number | null, dir?: string, since?: number) => {
    note('nextOwner', [departing, dir, since])
    return script.nextOwner(departing, dir, since)
  },
  pendingParkRequests: () => script.pending(),
  parkConcourseSession: (...args: unknown[]) => {
    note('park', args)
    return { outcome: 'applied', runnerId: 'concourse-w1' }
  },
  withdrawParkRequestsBy: (...args: unknown[]) => {
    note('withdraw', args)
    return args[1] as string[]
  },
  readSessionWorkers: () => {
    note('readRecords', [])
    return script.records
  },
}))
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({
  ...ownerWatch,
  getProcessStartTokenAsync: (pid: number) => {
    note('token', [pid])
    return script.token(pid)
  },
  startOwnerWatch: (options: WatchOptions) => {
    const watch = { options, stopped: false, pipeClosed: 0 }
    watches.push(watch)
    note('watch', [options.ownerPid, options.baselineToken])
    return {
      stop: () => {
        watch.stopped = true
      },
      ownerPipeClosed: () => {
        watch.pipeClosed++
      },
    }
  },
  armOwnerPipe: (fd: number, onClosed: () => void) => {
    const pipe = { fd, onClosed, closed: false }
    pipes.push(pipe)
    note('pipe', [fd])
    return {
      armed: script.pipeArmed,
      ...(script.pipeArmed ? {} : { why: 'the fd is closed' }),
      close: () => {
        pipe.closed = true
      },
    }
  },
  parseOwnerFd: () => script.ownerFd,
  isProcessAlive: (pid: number) => script.alive(pid),
}))
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...controlSocket,
  readDaemonState: async () => script.record,
  writeDaemonState: async (record: unknown) => {
    note('writeRecord', [record])
  },
}))
mock.module('../../src/daemon/control/idleRetirement.ts', () => ({ ...idleRetirement, sessionParkDrainMs: () => script.ceilingMs }))
mock.module('../../src/platform/async/sleep.ts', () => ({
  ...sleepDoor,
  sleep: async (ms: number) => {
    note('sleep', [ms])
    script.now += ms
  },
}))

const owner = await import('../../src/daemon/run/owner.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')
const { SESSIONLESS_EXIT_GRACE_MS } = await import('../../src/daemon/control/sessionlessExit.ts')

const roster = { planted: 'roster' }
const fresh = (): ReturnType<typeof makeDaemonRunState> => {
  const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
  state.roster = roster as never
  return state
}
const shutdowns: string[] = []
const needs = { shutdown: (signal: string) => void shutdowns.push(signal) }
const reset = (): void => {
  seen.length = 0
  said.length = 0
  shutdowns.length = 0
  watches.length = 0
  pipes.length = 0
  script.nextOwner = () => undefined
  script.pending = () => []
  script.token = () => Promise.resolve('the-baseline')
  script.ownerFd = null
  script.pipeArmed = true
  script.alive = () => true
  script.records = {}
  script.receipt = { parked: ['concourse-w1'], draining: [], released: [], skipped: [], refused: [] }
  script.record = { pid: process.pid, ownerPid: 4242, startToken: 'the-token-of-the-boot', startedAt: 1 }
}
const calls = (name: string): unknown[][] => seen.filter(s => s.call === name).map(s => s.args)
const order = (): string => seen.map(s => s.call).join(' ')
const drained = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve))
}
const orphan = async (state: ReturnType<typeof makeDaemonRunState>, afterTheArm: () => void = () => {}): Promise<void> => {
  state.currentOwnerPid ??= 111
  await owner.armOwnerWatch(state, needs, state.currentOwnerPid, false)
  afterTheArm()
  watches.at(-1)!.options.onOrphan('the pid is gone')
  await drained()
}
const realError = console.error
const realNow = Date.now
const realInterval = globalThis.setInterval
let intervals = 0
console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  intervals++
  return realInterval(...args)
}) as typeof setInterval

try {
  section('§1 the state reads the owner once, from the stamp the daemon was started with')
  {
    const state = fresh()
    check('G7 the owner the daemon answers for is the stamped pid until ownership passes', state.currentOwnerPid === 4242, state.currentOwnerPid)
    delete process.env.MERCURY_DAEMON_OWNER_PID
    check('a daemon started with no owner stamp has none', fresh().currentOwnerPid === null)
    check('the stamp is read at the boot alone: the state made before keeps its owner', state.currentOwnerPid === 4242)
  }

  section('§2 armOwnerWatch: the baseline is read first and asynchronously; an arm that went stale meanwhile arms nothing')
  {
    reset()
    const state = fresh()
    state.currentOwnerPid = 111
    let release: (token: string) => void = () => {}
    script.token = () => new Promise<string>(resolve => (release = resolve))
    intervals = 0
    const arming = owner.armOwnerWatch(state, needs, 111, false)
    await settle()
    check('the baseline token of the owner is asked for before any watch is armed', calls('token').length === 1 && calls('token')[0]![0] === 111 && watches.length === 0, order())
    release('token-111')
    await arming
    check('the watch is armed for that pid with the baseline it read', watches.length === 1 && watches[0]!.options.ownerPid === 111 && watches[0]!.options.baselineToken === 'token-111' && state.ownerWatch !== undefined, order())
    check("arming starts no beat of its own and asks for the token once: the beat is the watch's own", intervals === 0 && calls('token').length === 1, `${intervals} intervals`)
    check('no owner pipe is armed when the arm is asked without one', pipes.length === 0)

    reset()
    const stale = fresh()
    stale.currentOwnerPid = 111
    script.token = () => new Promise<string>(resolve => (release = resolve))
    const late = owner.armOwnerWatch(stale, needs, 111, false)
    await settle()
    stale.currentOwnerPid = 222
    release('token-111')
    await late
    check('ownership that moved while the baseline was read: nothing is armed for the old pid', watches.length === 0 && stale.ownerWatch === undefined, order())

    reset()
    const leaving = fresh()
    leaving.currentOwnerPid = 111
    leaving.shuttingDown = true
    await owner.armOwnerWatch(leaving, needs, 111, false)
    check('a daemon already on its way out arms no watch', watches.length === 0 && leaving.ownerWatch === undefined)

    reset()
    const rearmed = fresh()
    rearmed.currentOwnerPid = 111
    await owner.armOwnerWatch(rearmed, needs, 111, false)
    rearmed.currentOwnerPid = 112
    await owner.armOwnerWatch(rearmed, needs, 112, false)
    check('a second arm stops the watch before it', watches.length === 2 && watches[0]!.stopped && !watches[1]!.stopped)
  }

  section('§3 the owner pipe is armed with the first watch, on the fd the spawner stamped')
  {
    reset()
    const state = fresh()
    state.currentOwnerPid = 111
    script.ownerFd = 3
    await owner.armOwnerWatch(state, needs, 111, true)
    check('the daemon wires the one owner watch and the owner pipe', watches.length === 1 && pipes.length === 1 && pipes[0]!.fd === 3 && state.ownerPipe !== undefined, order())
    pipes[0]!.onClosed()
    check("the pipe's end is handed to the watch", watches[0]!.pipeClosed === 1)
    check('an armed pipe says nothing', !said.some(line => line.includes('owner pipe not armed')))

    reset()
    const unarmed = fresh()
    unarmed.currentOwnerPid = 111
    script.ownerFd = 3
    script.pipeArmed = false
    await owner.armOwnerWatch(unarmed, needs, 111, true)
    check('a pipe that did not arm is named in the log, and the watch stands alone', said.some(line => line.includes('owner pipe not armed (the fd is closed)')) && watches.length === 1, said)

    reset()
    const noFd = fresh()
    noFd.currentOwnerPid = 111
    await owner.armOwnerWatch(noFd, needs, 111, true)
    check('with no stamped fd no pipe is armed', pipes.length === 0 && watches.length === 1)
  }

  section('§4 the owner goes: ownership passes to the next live cockpit, or every session is parked and the daemon leaves')
  {
    reset()
    const state = fresh()
    state.currentOwnerPid = 111
    script.ownerFd = 3
    await owner.armOwnerWatch(state, needs, 111, true)
    script.nextOwner = departing => (departing === 111 ? 333 : undefined)
    seen.length = 0
    watches[0]!.options.onOrphan('the pid is gone')
    await settle()
    check('the hand-over asks for the next live cockpit other than the one that left', calls('nextOwner').length === 1 && calls('nextOwner')[0]![0] === 111)
    check('ownership passes: the state names the new owner', state.currentOwnerPid === 333)
    check('G7 the daemon record is rewritten with the live owner', calls('writeRecord').length === 1 && (calls('writeRecord')[0]![0] as { ownerPid: number }).ownerPid === 333 && (calls('writeRecord')[0]![0] as { pid: number }).pid === process.pid, calls('writeRecord'))
    check('the rewrite carries the stored record whole, its identity baseline with it: nothing but the owner changes', JSON.stringify(calls('writeRecord')[0]?.[0]) === JSON.stringify({ pid: process.pid, ownerPid: 333, startToken: 'the-token-of-the-boot', startedAt: 1 }), calls('writeRecord'))
    check('the watch is armed again for the new owner, with no pipe', watches.length === 2 && watches[1]!.options.ownerPid === 333 && pipes.length === 1 && pipes[0]!.closed, order())
    check('the daemon stays up and says so', shutdowns.length === 0 && calls('parkAll').length === 0 && said.some(line => line.includes('owner pid 111 gone (the pid is gone) — ownership passes to the live cockpit pid 333; the daemon stays up')), said)

    reset()
    const foreign = fresh()
    foreign.currentOwnerPid = 111
    script.record = { pid: process.pid + 1, ownerPid: 4242 }
    script.nextOwner = departing => (departing === 111 ? 555 : undefined)
    await orphan(foreign)
    check('a record that names another daemon is left as it is', calls('writeRecord').length === 0 && foreign.currentOwnerPid === 555, calls('writeRecord'))

    reset()
    const orphaned = fresh()
    orphaned.currentOwnerPid = 111
    await owner.armOwnerWatch(orphaned, needs, 111, false)
    seen.length = 0
    watches[0]!.options.onOrphan('the pid is gone')
    await settle()
    check('parkAllThenShutdown fires only when no live cockpit remains', said.some(line => line.includes('owner pid 111 gone (the pid is gone) — no live cockpit remains: parking every active session, then self-reaping (orphaned auto-start)')) && shutdowns.join() === 'owner-orphaned', said)
    check("the owned daemon's orphan reap parks-all first, under the daemon's own name, with the roster", calls('parkAll').length === 1 && calls('parkAll')[0]![0] === 'daemon:owner-orphaned' && calls('parkAll')[0]![1] === roster && orphaned.currentOwnerPid === 111, order())
    check('the reap keeps nothing back: it parks with no exception for a chat a live terminal holds', calls('parkAll')[0]!.length === 2, calls('parkAll')[0])
  }

  section('§5 the orphan reap, by the watch that fires it: the drain under the ceiling, the cut, the screen that comes back, the latch')
  {
    reset()
    Date.now = () => script.now
    const state = fresh()
    script.receipt = { parked: [], draining: ['concourse-w1'], released: [], skipped: [], refused: [] }
    script.pending = () => ['concourse-w1']
    script.records = { 'concourse-w1': { sessionId: 'session-one' } }
    script.ceilingMs = 2500
    const started = script.now
    await orphan(state)
    check('it waits for the mid-turn parks a second at a time, up to the registered ceiling', calls('sleep').length === 3 && calls('sleep').every(a => a[0] === 1000) && script.now - started === 3000, calls('sleep'))
    check('what is still mid-turn at the ceiling is cut with the ruled reason, not after its turn', calls('park').length === 1 && calls('park')[0]![0] === 'session-one' && calls('park')[0]![1] === 'daemon:owner-orphaned' && calls('park')[0]![2] === roster && JSON.stringify(calls('park')[0]![4]) === JSON.stringify({ afterTurn: false, reason: workers.PARK_DRAIN_CUT_REASON }), calls('park'))
    check('then, and only then, the daemon shuts down', shutdowns.join() === 'owner-orphaned' && order().lastIndexOf('park') > order().indexOf('parkAll') && said.some(line => line.includes('concourse-w1 was still mid-turn at the drain ceiling — its turn is cut and it parks')), said)
    check('the park line counts what it parked and what drains', said.some(line => line.includes('the screen is gone — parking every active session: parked 0, draining 1 (finishing their turns), released 0 newborn(s), skipped 0')), said)
    const before = calls('parkAll').length
    watches.at(-1)!.options.onOrphan('the pid is gone')
    await drained()
    check('latched: a second reap while the first stands parks nothing again', calls('parkAll').length === before && shutdowns.length === 1, order())

    reset()
    const leaving = fresh()
    await orphan(leaving, () => {
      leaving.shuttingDown = true
    })
    check('a daemon already on its way out is not parked a second time', watches.length === 1 && calls('parkAll').length === 0 && shutdowns.length === 0, order())

    reset()
    const back = fresh()
    back.currentOwnerPid = 111
    script.receipt = { parked: [], draining: ['concourse-w1', 'concourse-w2'], released: [], skipped: [], refused: [] }
    script.pending = () => ['concourse-w1', 'concourse-w2']
    script.ceilingMs = 60_000
    let asked = 0
    script.nextOwner = (departing, _dir, since) => (departing === null && typeof since === 'number' && ++asked >= 2 ? 444 : undefined)
    await orphan(back)
    await settle()
    check('a cockpit that came back inside the drain takes ownership and the daemon stays up', shutdowns.length === 0 && back.currentOwnerPid === 444 && calls('sleep').length === 2 && calls('park').length === 0, order())
    check('the parks asked at the reap are withdrawn for the sessions still draining', calls('withdraw').length === 1 && calls('withdraw')[0]![0] === 'daemon:owner-orphaned' && JSON.stringify(calls('withdraw')[0]![1]) === JSON.stringify(['concourse-w1', 'concourse-w2']) && said.some(line => line.includes('the screen came back inside the drain — ownership passes to the live cockpit pid 444; the daemon stays up and concourse-w1, concourse-w2 keep their turns')), said)
    check('the latch is open again: a later reap parks', back.orphanParking === false)

    reset()
    const thrown = fresh()
    script.pending = () => {
      throw new Error('the records are unreadable')
    }
    await orphan(thrown)
    check('a reap that throws still shuts the daemon down', shutdowns.join() === 'owner-orphaned', shutdowns)
    Date.now = realNow
  }

  section('§6 the sessionless beat: the decision is beaten from memory and the daemon leaves on its verdict')
  {
    reset()
    const lives = { live: 0, asked: 0 }
    const beatNeeds = {
      liveWorkers: () => {
        lives.asked++
        return { live: lives.live }
      },
      requestShutdown: (signal: string) => void shutdowns.push(signal),
    }
    const never = fresh()
    never.currentOwnerPid = process.pid
    owner.makeSessionlessBeat(never, beatNeeds)()
    check('a daemon that never hosted a session is held, and the beat reads no record for it', shutdowns.length === 0 && calls('readRecords').length === 0 && lives.asked === 1 && said.length === 0, { order: order(), said })

    reset()
    const hosting = fresh()
    hosting.currentOwnerPid = process.pid
    lives.live = 1
    lives.asked = 0
    const beat = owner.makeSessionlessBeat(hosting, beatNeeds)
    beat()
    check('a live worker marks the daemon as hosting', hosting.sessionless.hosted === true && shutdowns.length === 0)
    lives.live = 0
    Date.now = () => script.now
    beat()
    check('the first empty beat starts the grace and leaves nothing in the log', hosting.sessionless.emptySince === script.now && shutdowns.length === 0 && said.length === 0, said)
    check('the beat runs no subprocess: an in-memory live count, and one record read only when a candidate', calls('readRecords').length === 1 && lives.asked === 2, order())
    script.now += SESSIONLESS_EXIT_GRACE_MS
    beat()
    check('the daemon beats the sessionless decision and shuts down on its verdict', shutdowns.join() === 'sessionless' && said.some(line => line.includes('the last session this daemon hosted has exited (empty for 30s) — shutting down')), said)

    reset()
    const born = fresh()
    born.currentOwnerPid = process.pid
    born.sessionless = { hosted: true, emptySince: script.now - SESSIONLESS_EXIT_GRACE_MS }
    born.birthsInFlight = 1
    owner.makeSessionlessBeat(born, beatNeeds)()
    check('a birth in flight holds it past the grace', shutdowns.length === 0 && born.sessionless.emptySince === null)

    reset()
    const scheduled = fresh()
    scheduled.currentOwnerPid = process.pid
    scheduled.sessionless = { hosted: true, emptySince: script.now - SESSIONLESS_EXIT_GRACE_MS }
    script.records = { 'concourse-w1': { sessionId: 'session-one', schedules: [{}] } }
    const scheduledBeat = owner.makeSessionlessBeat(scheduled, beatNeeds)
    scheduledBeat()
    scheduledBeat()
    check('a session schedule holds it, and the hold is said once, not every beat', shutdowns.length === 0 && said.filter(line => line.includes('no session is hosted here — held by: a session schedule or held wake waits on this daemon')).length === 1, said)
    script.records = { 'concourse-w1': { sessionId: 'session-one', endedAt: 1, schedules: [{}] } }
    scheduledBeat()
    script.now += SESSIONLESS_EXIT_GRACE_MS
    scheduledBeat()
    check('a schedule on a record that has ended holds nothing: the grace starts again and the daemon leaves at its end', shutdowns.join() === 'sessionless', shutdowns)

    reset()
    const superseded = fresh()
    superseded.currentOwnerPid = null
    superseded.planeServedByOther = { pid: process.pid, buildTree: 'bbbbbbbbbbbb', alive: true }
    owner.makeSessionlessBeat(superseded, beatNeeds)()
    check('the beat acts on the plane owner the heal already read: a superseded daemon that holds nothing leaves, hosted or not, owned or not', shutdowns.join() === 'sessionless' && said.some(line => line.includes('the plane is served by a newer daemon and the last session this daemon held has exited — shutting down')) && calls('readRecords').length === 0, { said, order: order() })

    reset()
    const gone = fresh()
    gone.currentOwnerPid = null
    gone.planeServedByOther = { pid: 999_999, buildTree: 'bbbbbbbbbbbb', alive: true }
    script.alive = pid => pid !== 999_999
    gone.sessionless = { hosted: true, emptySince: script.now - SESSIONLESS_EXIT_GRACE_MS }
    owner.makeSessionlessBeat(gone, beatNeeds)()
    check('a plane owner that died is no reason to leave: the daemon with no owner persists', shutdowns.length === 0)

    reset()
    const restarting = fresh()
    restarting.restartAfterTeardown = true
    lives.asked = 0
    owner.makeSessionlessBeat(restarting, beatNeeds)()
    check('a daemon that is restarting after its teardown is not beaten', lives.asked === 0 && shutdowns.length === 0)
    Date.now = realNow
  }

  section('§7 a spawned session marks the daemon as hosting')
  {
    reset()
    const state = fresh()
    const first = state.sessionless
    owner.markHosted(state)
    check('markHosted flips hosted once', state.sessionless.hosted === true && first.hosted === false)
    const marked = state.sessionless
    owner.markHosted(state)
    check('a second mark changes nothing', state.sessionless === marked)
  }
} finally {
  console.error = realError
  Date.now = realNow
  globalThis.setInterval = realInterval
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-owner-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
