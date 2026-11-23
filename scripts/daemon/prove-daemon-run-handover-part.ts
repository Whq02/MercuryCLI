#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-handover-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const PART = 'src/daemon/run/handover.ts'

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — the list above is what the part did; change armHandoverBeats in ${PART} (the idle-predecessor sweep and the handover lock beat) until it does what the label says` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const realImmediate = globalThis.setImmediate
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60; i++) await Promise.resolve()
    await new Promise<void>(done => realImmediate(() => done()))
  }
}

type Reply = { ok: boolean; op?: string; pid?: number; live?: number; version?: string }
const did: string[] = []
const note = (what: string): void => void did.push(what)
const OLDER = 777
const script = {
  alive: new Set<number>([OLDER]),
  sockets: [] as number[],
  homeStands: true,
  lockHolder: null as number | null,
  otherBuild: false,
  hello: { ok: true, op: 'hello', pid: OLDER, live: 0, version: '1.0.0' } as Reply,
  lock: { release: async () => {} } as { release: () => Promise<void> } | null,
  held: null as string | null,
  fails: null as string | null,
}
let letGo: (() => void) | null = null
const neighbour = <T>(what: string, answer: T): Promise<T> => {
  note(what)
  if (script.fails === what) return Promise.reject(new Error(`${what}: planted failure`))
  if (script.held !== what) return Promise.resolve(answer)
  return new Promise<T>(done => {
    letGo = () => done(answer)
  })
}
const timers: Array<{ ms: number; run: () => void; unref: boolean }> = []

const promises = await import('fs/promises')
const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const daemonHome = await import('../../src/daemon/control/daemonHome.ts')
const handover = await import('../../src/daemon/control/handover.ts')
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const planeRecords = await import('../../src/daemon/control/planeRecords.ts')
const status = await import('../../src/daemon/control/status.ts')
const restart = await import('../../src/daemon/run/restart.ts')
const debug = await import('../../src/platform/logs/debugLog.ts')
mock.module('fs/promises', () => ({ ...promises, unlink: (path: string) => neighbour(`unlink ${basename(path)}`, undefined) }))
mock.module('../../src/daemon/control/controlSocket.ts', () => ({ ...controlSocket, acquireDaemonLock: () => neighbour('take the daemon lock', script.lock) }))
mock.module('../../src/daemon/control/daemonHome.ts', () => ({ ...daemonHome, daemonHomeStands: () => script.homeStands }))
mock.module('../../src/daemon/control/handover.ts', () => ({
  ...handover,
  forwardFrame: (sock: string, line: string, ms: number) => {
    const asked = JSON.parse(line) as { op: string; reapWorkers?: boolean; forwarded?: boolean; clientBuildTree?: string }
    const what = `${asked.op === 'hello' ? `hello to ${basename(sock)} within ${ms} ms, as build ${asked.clientBuildTree}` : `${asked.op} to ${basename(sock)} within ${ms} ms, reaping ${asked.reapWorkers}, forwarded ${asked.forwarded}`}`
    return neighbour(what, asked.op === 'hello' ? script.hello : { ok: true, op: 'shutdown' })
  },
}))
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({ ...ownerWatch, isProcessAlive: (pid: number) => script.alive.has(pid) }))
mock.module('../../src/daemon/control/planeRecords.ts', () => ({
  ...planeRecords,
  lockHeldByLivePidSync: () => {
    note('read who holds the daemon lock')
    return script.lockHolder
  },
}))
mock.module('../../src/daemon/control/status.ts', () => ({ ...status, helperPidSocketsOnDisk: () => script.sockets }))
mock.module('../../src/daemon/run/restart.ts', () => ({ ...restart, successorRuntime: () => (script.otherBuild ? { buildTree: 'cccccccccccc', script: '/other/mercury.mjs', version: '1.0.0', layout: 'source' } : null) }))
mock.module('../../src/platform/logs/debugLog.ts', () => ({ ...debug, logForDebugging: (line: string) => note(`debug: ${line}`) }))

const part = await import('../../src/daemon/run/handover.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

type State = ReturnType<typeof makeDaemonRunState>
const OURS = 'aaaaaaaaaaaa'
const rows = new Map<string, { work: () => void; alsoStops: (() => void) | null }>()
const hosts = { held: new Set<string>() }
const HELLO = `hello to control.sock.${OLDER} within 1500 ms, as build ${OURS}`
const LEAVE = `shutdown to control.sock.${OLDER} within 3000 ms, reaping false, forwarded true`
const ASKING = `say: [daemon] the daemon this one took over from (pid ${OLDER}, v1.0.0) holds no live session and has not left on its own — asking it to leave`
const arm = (how: { handover: boolean; lock: boolean; predecessor?: number | null }): State => {
  did.length = 0
  timers.length = 0
  rows.clear()
  hosts.held = new Set()
  Object.assign(script, { alive: new Set([OLDER]), sockets: [], homeStands: true, lockHolder: null, otherBuild: false, hello: { ok: true, op: 'hello', pid: OLDER, live: 0, version: '1.0.0' }, lock: { release: async () => {} }, held: null, fails: null })
  letGo = null
  const state = makeDaemonRunState({ dir: home, bootBuildTree: OURS, foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
  if (how.handover) state.handover = { predecessorPids: () => [OLDER], heldRunners: () => hosts.held } as never
  if (how.lock) state.daemonLock = { release: async () => {} }
  part.armHandoverBeats(state, {
    handoverPredecessor: how.predecessor === undefined ? (how.handover ? OLDER : null) : how.predecessor,
    armPeriodic: ((name: string, work: () => void, alsoStops?: () => void) => {
      note(`arm "${name}"`)
      rows.set(name, { work, alsoStops: alsoStops ?? null })
      state.stopLockBeat = name === 'the handover lock beat' ? () => (note('the lock beat is stopped'), alsoStops?.()) : state.stopLockBeat
      return {} as never
    }) as never,
  })
  return state
}
const SWEEP = 'the idle-predecessor sweep'
const LOCK = 'the handover lock beat'
const run = async (row: string): Promise<string[]> => {
  did.length = 0
  rows.get(row)?.work()
  await settle()
  return [...did]
}

const realError = console.error
const realTimeout = globalThis.setTimeout
console.error = (...args: unknown[]) => note(`say: ${args.map(String).join(' ')}`)
globalThis.setTimeout = ((work: () => void, ms?: number) => {
  const timer = { ms: ms ?? 0, run: work, unref: false }
  timers.push(timer)
  note(`timer ${ms}`)
  return {
    unref: () => {
      timer.unref = true
    },
  }
}) as never

try {
  section('§1 what a boot arms: nothing without a handover; the sweep with one; the lock beat when the lock was not taken')
  {
    arm({ handover: false, lock: true })
    check('a daemon that took the plane from nobody arms neither beat and no timer', did.length === 0, did)
    arm({ handover: true, lock: true })
    check('after a handover with the lock in hand: the sweep by the periodic list, then its first run a second out, not holding the process open; no lock beat', did.join(' · ') === [`arm "${SWEEP}"`, 'timer 1000'].join(' · ') && timers[0]!.unref === true, did)
    arm({ handover: true, lock: false })
    check('after a handover without the lock: the sweep, its first run, then the lock beat', did.join(' · ') === [`arm "${SWEEP}"`, 'timer 1000', `arm "${LOCK}"`].join(' · '), did)
    arm({ handover: false, lock: false, predecessor: 4 })
    check('a daemon that names a predecessor and holds no handover state arms the lock beat alone', did.join(' · ') === `arm "${LOCK}"`, did)
    arm({ handover: true, lock: true })
    did.length = 0
    timers[0]!.run()
    await settle()
    check('the first run, a second after the boot, is the sweep itself', did[0] === HELLO, did)
  }

  section('§2 the sweep: the sockets of helpers that left, and an older daemon that reads idle')
  {
    arm({ handover: true, lock: true })
    script.sockets = [process.pid, OLDER, 555, 556]
    const swept = await run(SWEEP)
    check('the socket of a helper that is gone is removed; this daemon\'s own and a live helper\'s are left', swept.filter(line => line.startsWith('unlink')).join() === 'unlink control.sock.555,unlink control.sock.556', swept)
    script.homeStands = false
    check('with the home gone no socket is removed', !(await run(SWEEP)).some(line => line.startsWith('unlink')), did)

    arm({ handover: true, lock: true })
    check('an idle read is one hello, as this build, 1.5 s at most; with the lock in hand the lock is not read, and the first read asks nobody to leave', (await run(SWEEP)).join(' · ') === HELLO, did)
    await run(SWEEP)
    check('…nor the second', !did.includes(LEAVE), did)
    check('the third in a row says it and asks the older daemon to leave: workers kept, marked forwarded, 3 s at most', (await run(SWEEP)).join(' · ') === [HELLO, ASKING, LEAVE].join(' · '), did)
    check('…and the count starts again after it has asked', !(await run(SWEEP)).includes(LEAVE), did)

    arm({ handover: true, lock: true })
    await run(SWEEP)
    await run(SWEEP)
    script.hello = { ok: true, op: 'hello', pid: OLDER, live: 1, version: '1.0.0' }
    await run(SWEEP)
    script.hello = { ok: true, op: 'hello', pid: OLDER, live: 0, version: '1.0.0' }
    check('a read that finds it working forgets the idle reads before it', !(await run(SWEEP)).includes(LEAVE) && !(await run(SWEEP)).includes(LEAVE) && (await run(SWEEP)).includes(LEAVE), did)

    arm({ handover: true, lock: true })
    hosts.held = new Set(['concourse-w1'])
    check('an older daemon that still hosts a runner is not read at all', (await run(SWEEP)).length === 0, did)

    arm({ handover: true, lock: false })
    script.lockHolder = OLDER
    check('an idle older daemon that holds the daemon lock this one waits for is asked at its first idle read', (await run(SWEEP)).join(' · ') === [HELLO, 'read who holds the daemon lock', ASKING, LEAVE].join(' · '), did)

    arm({ handover: true, lock: true })
    const state = arm({ handover: true, lock: true })
    state.planeServedByOther = { pid: 999, buildTree: 'bbbbbbbbbbbb', alive: true }
    check('a daemon that reads the plane as served by another sweeps nothing', (await run(SWEEP)).length === 0, did)
    arm({ handover: true, lock: true })
    script.otherBuild = true
    check('a daemon that is not the installed build sweeps nothing', (await run(SWEEP)).length === 0, did)
  }

  section('§3 what the sweep waits for, and a sweep that fails')
  {
    arm({ handover: true, lock: false })
    script.lockHolder = OLDER
    script.held = HELLO
    const before = await run(SWEEP)
    check('while the hello is held open nothing after it has happened', letGo !== null && before.join() === HELLO, before)
    rows.get(SWEEP)?.work()
    await settle()
    check('…and a beat that lands meanwhile starts no second sweep', did.join() === HELLO, did)
    const open = letGo as (() => void) | null
    script.held = LEAVE
    letGo = null
    open?.()
    await settle()
    check('…once it answers the ask follows, and the sweep waits for the ask in its turn', did.join(' · ') === [HELLO, 'read who holds the daemon lock', ASKING, LEAVE].join(' · ') && letGo !== null, did)
    rows.get(SWEEP)?.work()
    await settle()
    check('…a beat that lands while the ask is open still starts nothing', did.filter(line => line === HELLO).length === 1, did)
    ;(letGo as (() => void) | null)?.()
    await settle()
    script.held = null
    check('…and when the ask has settled the next beat sweeps again', (await run(SWEEP)).includes(HELLO), did)

    arm({ handover: true, lock: true })
    script.fails = HELLO
    check('a hello that fails is logged for the next beat', (await run(SWEEP)).join(' · ') === [HELLO, `debug: [daemon] the idle-predecessor sweep failed (the next beat retries): Error: ${HELLO}: planted failure`].join(' · '), did)
    script.fails = null
    check('…and the next beat sweeps again', (await run(SWEEP)).includes(HELLO), did)
    arm({ handover: true, lock: false })
    script.lockHolder = OLDER
    script.fails = LEAVE
    check('an ask to leave that fails is passed over: nothing is logged and the sweep ends', (await run(SWEEP)).join(' · ') === [HELLO, 'read who holds the daemon lock', ASKING, LEAVE].join(' · '), did)
  }

  section('§4 the lock beat: the daemon lock is taken once its holder has left, and the beat stops itself')
  {
    const waiting = arm({ handover: true, lock: false })
    script.lockHolder = OLDER
    check('while a live process holds the lock the beat reads the holder and takes nothing', (await run(LOCK)).join() === 'read who holds the daemon lock' && waiting.daemonLock === null, did)
    script.lockHolder = null
    script.lock = null
    check('with the holder gone it asks for the lock; refused, it holds nothing and goes on beating', (await run(LOCK)).join(' · ') === ['read who holds the daemon lock', 'take the daemon lock'].join(' · ') && waiting.daemonLock === null && waiting.stopLockBeat !== null, did)
    const taken = { release: async () => {} }
    script.lock = taken
    script.held = 'take the daemon lock'
    const before = await run(LOCK)
    check('while the take is held open nothing after it has happened', letGo !== null && before.join(' · ') === ['read who holds the daemon lock', 'take the daemon lock'].join(' · ') && waiting.daemonLock === null, before)
    rows.get(LOCK)?.work()
    await settle()
    check('…and a beat that lands meanwhile asks for no second lock', did.filter(line => line === 'take the daemon lock').length === 1, did)
    ;(letGo as (() => void) | null)?.()
    await settle()
    check('…once it is taken the state holds it, the beat is stopped and the handle is let go, then the daemon says so', waiting.daemonLock === taken && waiting.stopLockBeat === null && did.slice(-2).join(' · ') === ['the lock beat is stopped', `say: [daemon] handover from pid ${OLDER}: the predecessor released the daemon lock — this daemon holds it now`].join(' · '), did)
    script.held = null
    check('a beat that fires with the lock in hand does nothing', (await run(LOCK)).length === 0, did)
  }
} finally {
  console.error = realError
  globalThis.setTimeout = realTimeout
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-handover-part: ${failures === 0 ? 'green' : `${failures} failed`} (${PART})`)
process.exit(failures === 0 ? 0 : 1)
