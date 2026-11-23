#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-heal-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_VERSIONS_DIR', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const PART = 'src/daemon/run/heal.ts'

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — the list above is what the part did; change armPlaneHeal in ${PART} until its beats and heals do what the label says` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const realImmediate = globalThis.setImmediate
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60; i++) await Promise.resolve()
    await new Promise<void>(done => realImmediate(() => done()))
  }
}

type Owner = { pid: number; buildTree: string | null; alive: boolean }
const did: string[] = []
const note = (what: string): void => void did.push(what)
const script = {
  missing: new Set<'the plane socket' | 'the control key' | 'its own socket'>(),
  owner: null as Owner | null,
  deployed: null as string | null,
  homeStands: [] as boolean[],
  held: null as string | null,
  fails: null as string | null,
}
let letGo: (() => void) | null = null
const neighbour = (what: string): Promise<void> => {
  note(what)
  if (script.fails === what) return Promise.reject(new Error(`${what}: planted failure`))
  if (script.held !== what) return Promise.resolve()
  return new Promise<void>(done => {
    letGo = done
  })
}
type Watch = { dir: string; persistent: unknown; fire: (name: string | null) => void; closed: boolean }
const watches: Watch[] = []
const timers: Array<{ ms: number; run: () => void; unref: boolean; cleared: boolean }> = []

const fs = await import('node:fs')
const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const daemonHome = await import('../../src/daemon/control/daemonHome.ts')
const handover = await import('../../src/daemon/control/handover.ts')
const planeRecords = await import('../../src/daemon/control/planeRecords.ts')
const debug = await import('../../src/platform/logs/debugLog.ts')
const SOCK = controlSocket.controlSockPath()
const KEY = controlSocket.controlKeyPath()
const OWN = handover.predecessorSockPath(process.pid)
mock.module('node:fs', () => ({
  ...fs,
  existsSync: (path: string) => (path === SOCK ? !script.missing.has('the plane socket') : path === KEY ? !script.missing.has('the control key') : path === OWN ? !script.missing.has('its own socket') : fs.existsSync(path)),
  watch: (dir: string, opts: { persistent?: boolean }, onChange: (event: string, name: string | null) => void) => {
    const watch: Watch = { dir, persistent: opts?.persistent, fire: name => onChange('rename', name), closed: false }
    watches.push(watch)
    note(`watch ${basename(dir)}`)
    return {
      on: () => {},
      close: () => {
        watch.closed = true
        note(`close the watch on ${basename(dir)}`)
      },
    }
  },
}))
mock.module('../../src/daemon/control/controlSocket.ts', () => ({ ...controlSocket, reassertControlKey: (key: string) => neighbour(`write the control key ${key} again`) }))
mock.module('../../src/daemon/control/daemonHome.ts', () => ({
  ...daemonHome,
  daemonHomeStands: (where: string) => {
    const stands = script.homeStands.shift() ?? true
    note(`does the home stand? (${where}: ${stands ? 'yes' : 'no'})`)
    return stands
  },
}))
mock.module('../../src/daemon/control/handover.ts', () => ({ ...handover, deployedRuntime: () => (script.deployed === null ? null : { buildTree: script.deployed, script: '/deployed/mercury.mjs', version: '1.0.0', layout: 'source' }) }))
mock.module('../../src/daemon/control/planeRecords.ts', () => ({
  ...planeRecords,
  readPlaneOwnerSync: () => {
    note('read who serves the plane')
    return script.owner
  },
}))
mock.module('../../src/platform/logs/debugLog.ts', () => ({ ...debug, logForDebugging: (line: string) => note(`debug: ${line}`) }))

const part = await import('../../src/daemon/run/heal.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

type State = ReturnType<typeof makeDaemonRunState>
const OURS = 'aaaaaaaaaaaa'
const THEIRS = 'bbbbbbbbbbbb'
const SELF_OWNER: Owner = { pid: process.pid, buildTree: OURS, alive: true }
const armed = { floor: null as (() => void) | null, alsoStops: null as (() => void) | null }
let asked = 0
const arm = (): State => {
  did.length = 0
  watches.length = 0
  timers.length = 0
  armed.floor = null
  armed.alsoStops = null
  asked = 0
  script.missing.clear()
  script.owner = SELF_OWNER
  script.deployed = OURS
  script.homeStands = []
  script.held = null
  script.fails = null
  letGo = null
  const state = makeDaemonRunState({ dir: home, bootBuildTree: OURS, foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
  state.currentOwnerPid = 4242
  state.controlServer = { close: async () => {}, rebind: () => neighbour('bind the control socket again'), leaseCount: () => 0 }
  let served: Owner | null = null
  Object.defineProperty(state, 'planeServedByOther', {
    get: () => served,
    set: (next: Owner | null) => {
      served = next
      note(`the plane is read as served by ${next === null ? 'nobody else' : `pid ${next.pid}`}`)
    },
  })
  part.armPlaneHeal(state, {
    controlKey: 'the-key',
    persistDaemonRecord: owner => neighbour(`write the daemon record for owner ${owner}`),
    askLiveSessionsForFacts: () => {
      note('ask the live sessions for their facts')
      return ++asked
    },
    armPeriodic: ((name: string, work: () => void, also?: () => void) => {
      note(`arm "${name}"`)
      armed.floor = work
      armed.alsoStops = also ?? null
      return {} as never
    }) as never,
  })
  return state
}
const beat = async (): Promise<string[]> => {
  did.length = 0
  armed.floor?.()
  await settle()
  return [...did]
}
const REASSERT = 'write the control key the-key again'
const RECORD = 'write the daemon record for owner 4242'
const REBIND = 'bind the control socket again'
const HEAL = 'does the home stand? (the plane heal: yes)'
const READ = 'read who serves the plane'
const NOBODY = 'the plane is read as served by nobody else'
const degraded = (sock: boolean, own: boolean, key: boolean, state: boolean, takeBack: boolean): string => `debug: [daemon] control plane degraded (sock:${sock} own:${own} key:${key} state:${state} takeBack:${takeBack}) — re-asserting`

const realError = console.error
const realTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
console.error = (...args: unknown[]) => note(`say: ${args.map(String).join(' ')}`)
globalThis.setTimeout = ((run: () => void, ms?: number) => {
  const timer = { ms: ms ?? 0, run, unref: false, cleared: false }
  timers.push(timer)
  note(`timer ${ms}`)
  return Object.assign(timer, {
    unref: () => {
      timer.unref = true
    },
  })
}) as never
globalThis.clearTimeout = ((timer: unknown) => {
  const known = timers.find(armed => armed === timer)
  if (known === undefined) return realClearTimeout(timer as never)
  known.cleared = true
  note(`clear the timer of ${known.ms}`)
}) as never

try {
  section('§1 arming the heal: the floor first, by the periodic list, then a watch on the folder of the plane and on the two folders an installed build is named in')
  {
    arm()
    check('the floor is armed as the row "the plane heal floor", before any watch, and the heal reads the installed build once as it arms', did.join(' · ') === ['arm "the plane heal floor"', 'watch daemon', 'watch runtime', 'watch versions'].join(' · '), did)
    check('each watch is one that does not hold the process open', watches.length === 3 && watches.every(watch => watch.persistent === false), watches.map(watch => watch.persistent))
  }

  section('§2 the heal check, by a tick of the floor: what it puts back, in what order, and what it leaves alone')
  {
    arm()
    check('a plane that stands and names this daemon: the check reads the home, the plane and who serves it, and writes nothing', (await beat()).join(' · ') === [HEAL, READ, NOBODY].join(' · '), did)

    arm()
    script.missing.add('the control key')
    check('the control key gone: the key is written again, then the daemon record, and the socket is left as it is', (await beat()).join(' · ') === [HEAL, READ, NOBODY, degraded(false, false, true, false, false), REASSERT, RECORD].join(' · '), did)

    arm()
    script.owner = null
    check('the daemon record gone: the key and the record are written again', (await beat()).join(' · ') === [HEAL, READ, NOBODY, degraded(false, false, false, true, false), REASSERT, RECORD].join(' · '), did)

    arm()
    script.missing.add('the plane socket')
    check('the plane socket gone: the key, the record, then the home is read a second time and the socket is bound again', (await beat()).join(' · ') === [HEAL, READ, NOBODY, degraded(true, false, false, false, false), REASSERT, RECORD, HEAL, REBIND].join(' · '), did)

    arm()
    script.missing.add('the plane socket')
    script.homeStands = [true, false]
    const gone = await beat()
    check('the heal reads the latch before it binds again: with the home gone by then, the socket is not bound', !gone.includes(REBIND) && gone.at(-1) === 'does the home stand? (the plane heal: no)', `${JSON.stringify(gone.slice(-3))} — in ${PART} the rebind stands behind daemonHomeStands('the plane heal') on its own line: a daemon whose home was removed must not publish a socket into a folder that is gone`)

    arm()
    script.homeStands = [false]
    check('with the home gone the check does nothing at all', (await beat()).join(' · ') === 'does the home stand? (the plane heal: no)', did)

    arm()
    script.owner = { pid: 777, buildTree: THEIRS, alive: false }
    check('a record that names a daemon that is gone reads as a record missing: the key and the record are written again', (await beat()).join(' · ') === [HEAL, READ, NOBODY, degraded(false, false, false, true, false), REASSERT, RECORD].join(' · '), did)

    arm()
    script.owner = { pid: 777, buildTree: THEIRS, alive: true }
    script.deployed = THEIRS
    check('a live daemon of the installed build serves the plane: it is read as serving, and nothing of the plane is touched', (await beat()).join(' · ') === [HEAL, READ, 'the plane is read as served by pid 777'].join(' · '), did)

    arm()
    script.owner = { pid: 777, buildTree: THEIRS, alive: true }
    script.deployed = THEIRS
    script.missing.add('its own socket')
    check('…and when this daemon\'s own socket is gone beside it, that socket alone is bound again: no key, no record', (await beat()).join(' · ') === [HEAL, READ, 'the plane is read as served by pid 777', degraded(false, true, false, false, false), HEAL, REBIND].join(' · '), did)

    arm()
    script.owner = { pid: 777, buildTree: THEIRS, alive: true }
    script.deployed = OURS
    check('a live daemon of another build serves the plane while this one is the installed build: it says so and takes the plane back, key, record and socket', (await beat()).join(' · ') === [HEAL, READ, NOBODY, `say: [daemon] pid 777 of build ${THEIRS} took the plane from the deployed build ${OURS} — taking it back`, degraded(false, false, false, false, true), REASSERT, RECORD, HEAL, REBIND].join(' · '), did)
  }

  section('§3 what the check waits for: each neighbour it awaits is held open, nothing after it has happened, it is let go, the rest follows; one check at a time')
  {
    const whole = [HEAL, READ, NOBODY, degraded(true, false, false, false, false), REASSERT, RECORD, HEAL, REBIND]
    for (const [neighbour, said] of [[REASSERT, 'the write of the control key'], [RECORD, 'the write of the daemon record'], [REBIND, 'the bind of the socket']] as const) {
      arm()
      script.missing.add('the plane socket')
      script.held = neighbour
      const before = await beat()
      check(`while ${said} is held open nothing after it has happened`, letGo !== null && before.join(' · ') === whole.slice(0, whole.indexOf(neighbour) + 1).join(' · '), `${JSON.stringify(before.slice(whole.indexOf(neighbour) + 1))} ran before it settled — in ${PART} the check awaits it`)
      armed.floor?.()
      armed.floor?.()
      await settle()
      check('…and a tick that lands meanwhile starts no second check beside it', did.length === before.length, did.slice(before.length))
      script.held = null
      script.missing.clear()
      const open = letGo as (() => void) | null
      open?.()
      await settle()
      const after = did.slice(before.length)
      check('…once it settles the rest follows, and the ticks that landed are answered by one more check, not two', did.slice(0, whole.length).join(' · ') === whole.join(' · ') && after.slice(whole.length - before.length).join(' · ') === [HEAL, READ, NOBODY].join(' · '), after)
    }
    arm()
    script.missing.add('the control key')
    script.fails = REASSERT
    const failed = await beat()
    check('a write that fails is logged and the check is over: the record is not written behind a key that failed', failed.at(-1) === `debug: [daemon] plane self-heal failed (the next signal or floor retries): Error: ${REASSERT}: planted failure` && !failed.includes(RECORD), failed.slice(-3))
    script.fails = null
    check('…and the next tick checks again', (await beat()).includes(RECORD), did)
  }

  section('§4 the watches: a change of a plane file calls the check once, a quarter of a second later; a new installed build is told to the live sessions')
  {
    arm()
    const plane = watches[0]!
    did.length = 0
    plane.fire('concourse-workers.json')
    check('a file that is not of the plane changes: nothing is armed', did.length === 0, did)
    plane.fire('control.key')
    plane.fire('daemon.json')
    plane.fire(basename(SOCK))
    check('three plane files change at once: one timer of 250 ms, not holding the process open', did.join() === 'timer 250' && timers.length === 1 && timers[0]!.unref === true, did)
    timers[0]!.run()
    await settle()
    check('the timer runs the heal check', did.slice(1).join(' · ') === [HEAL, READ, NOBODY].join(' · '), did)
    plane.fire(null)
    check('a change with no name is taken as one of the plane, and after the first timer ran a second one is armed', timers.length === 2, did)

    did.length = 0
    const pointers = watches[1]!
    pointers.fire('builds')
    check('a file that is not an installed-build pointer changes: nothing is armed', did.length === 0, did)
    pointers.fire('current')
    script.deployed = THEIRS
    timers.at(-1)!.run()
    check('the pointer moves to another build: the live sessions are asked for their facts and the daemon says which build, with how many it asked', did.join(' · ') === ['timer 250', 'ask the live sessions for their facts', `say: [daemon] the installed build moved to ${THEIRS} — 1 live session(s) asked for their facts now`].join(' · '), did)
    did.length = 0
    pointers.fire('current')
    timers.at(-1)!.run()
    check('the pointer is touched and names the same build: nothing is asked or said', did.join() === 'timer 250', did)
  }

  section('§5 what stops the heal on the way out, beside its interval: the two pending timers and every watch')
  {
    arm()
    watches[0]!.fire('control.key')
    watches[1]!.fire('current')
    did.length = 0
    armed.alsoStops?.()
    check('both pending timers are cleared and the three watches are closed, the plane\'s first', did.join(' · ') === ['clear the timer of 250', 'clear the timer of 250', 'close the watch on daemon', 'close the watch on runtime', 'close the watch on versions'].join(' · ') && timers.every(timer => timer.cleared) && watches.every(watch => watch.closed), did)
    arm()
    did.length = 0
    armed.alsoStops?.()
    check('with no timer pending only the watches are closed', did.join(' · ') === ['close the watch on daemon', 'close the watch on runtime', 'close the watch on versions'].join(' · '), did)
  }
} finally {
  console.error = realError
  globalThis.setTimeout = realTimeout
  globalThis.clearTimeout = realClearTimeout
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-heal-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
