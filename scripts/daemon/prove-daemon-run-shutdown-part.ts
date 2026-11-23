#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-shutdown-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SELF = 'scripts/daemon/prove-daemon-run-shutdown-part.ts'
const PART = 'src/daemon/run/shutdown.ts'

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — the list above is what the part did; change shutdownDaemon and bindWayOut in ${PART} until its steps match the label` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const realImmediate = globalThis.setImmediate
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 80; i++) await Promise.resolve()
    await new Promise<void>(done => realImmediate(() => done()))
  }
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

const did: string[] = []
const note = (what: string): void => void did.push(what)
const script = {
  supersededBy: null as { pid: number; buildTree: string | null; alive: boolean } | null,
  held: null as string | null,
  fails: null as string | null,
}
let letGo: (() => void) | null = null
const timers: Array<{ ms: number; run: () => void; unref: boolean }> = []
const neighbour = (what: string): Promise<void> => {
  note(what)
  if (script.fails === what) return Promise.reject(new Error(`${what}: planted failure`))
  if (script.held !== what) return Promise.resolve()
  return new Promise<void>(done => {
    letGo = done
  })
}
const noting = <T extends object>(who: string, plantedCalls: T): T =>
  new Proxy(plantedCalls, {
    get: (target, key, receiver) => (typeof key === 'symbol' || key in target ? Reflect.get(target, key, receiver) : key === 'then' ? undefined : () => note(`${who}.${key}()`)),
  })

const STAND_INS = {
  '../../platform/logs/debugLog.js': { logForDebugging: (line: string) => note(`debug: ${line}`) },
  '../roster/spawnLedger.js': { recordSpawnExit: (row: { kind: string; event: string; id: string; reason: string }) => note(`ledger ${row.kind} ${row.event} ${row.id} ${row.reason}`) },
  '../../platform/processes/processGroup.js': { treeEndsSettled: (boundMs: number) => neighbour(`the killed trees settled within ${boundMs} ms`) },
  '../control/controlSocket.js': {
    clearControlKey: () => neighbour('clear the control key'),
    clearDaemonState: () => neighbour('clear the daemon record'),
    markDaemonStoppingSync: () => {
      note('mark the record stopping')
      return true
    },
  },
  '../control/planeRecords.js': {
    supersededByLivePlaneOwnerSync: () => {
      note('read who serves the plane')
      return script.supersededBy
    },
  },
}

const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const planeRecords = await import('../../src/daemon/control/planeRecords.ts')
const spawnLedger = await import('../../src/daemon/roster/spawnLedger.ts')
const debug = await import('../../src/platform/logs/debugLog.ts')
const processGroup = await import('../../src/platform/processes/processGroup.ts')
mock.module('../../src/daemon/control/controlSocket.ts', () => ({ ...controlSocket, ...STAND_INS['../control/controlSocket.js'] }))
mock.module('../../src/daemon/control/planeRecords.ts', () => ({ ...planeRecords, ...STAND_INS['../control/planeRecords.js'] }))
mock.module('../../src/daemon/roster/spawnLedger.ts', () => ({ ...spawnLedger, ...STAND_INS['../roster/spawnLedger.js'] }))
mock.module('../../src/platform/logs/debugLog.ts', () => ({ ...debug, ...STAND_INS['../../platform/logs/debugLog.js'] }))
mock.module('../../src/platform/processes/processGroup.ts', () => ({ ...processGroup, ...STAND_INS['../../platform/processes/processGroup.js'] }))

const part = await import('../../src/daemon/run/shutdown.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

type State = ReturnType<typeof makeDaemonRunState>
const KEEP_ALIVE = { the: 'keep-alive' } as unknown as ReturnType<typeof setInterval>
const needs = {
  keepAlive: KEEP_ALIVE,
  resolveShutdown: () => note('resolve the run'),
  spawnSuccessorDaemon: () => {
    note('spawn the successor')
    return 4242
  },
}
const shown = (value: unknown): string => (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number' ? String(value) : 'a value')
const planted = (over: Partial<State> = {}, controlEnabled = true): State => {
  const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: noting('the breaker', new DaemonBreaker()), maxInflight: 1, controlEnabled })
  state.stopPlaneHeal = () => note('stop the plane heal')
  state.stopArmedBeat = () => note('stop the armed-restart beat')
  state.stopLockBeat = () => note('stop the handover lock beat')
  state.stopSessionlessBeat = () => note('stop the sessionless beat')
  state.stopSaturnTicker = () => note('stop the Saturn ticker')
  state.stopHostJobs = () => note('stop the host job sweep')
  state.ownerWatch = noting('the owner watch', { stop: () => note('stop the owner watch') }) as never
  state.ownerPipe = noting('the owner pipe', { armed: true, close: () => note('close the owner pipe') }) as never
  state.roster = noting('the roster', {
    list: () => {
      note('list the roster')
      return [
        { short: 'concourse-w1', pid: 11, via: 'runner' },
        { short: 'job-2', pid: 12, via: 'headless' },
        { short: 'done-3', pid: 13, via: 'runner', outcome: { ok: true } },
      ]
    },
    kill: (short: string) => {
      note(`kill ${short}`)
      return true
    },
    askedSettled: () => neighbour('the asked runners settled'),
  }) as never
  state.controlServer = noting('the control server', { close: () => neighbour('close the control server') }) as never
  state.releaseHeldReading = () => note('release the held reading')
  state.daemonLock = noting('the daemon lock', { release: () => neighbour('release the daemon lock') })
  Object.assign(state, over)
  return new Proxy(state, {
    set: (target, key, value) => {
      note(`state.${String(key)} = ${shown(value)}`)
      return Reflect.set(target, key, value)
    },
  })
}
const reset = (): void => {
  did.length = 0
  timers.length = 0
  script.supersededBy = null
  script.held = null
  script.fails = null
  letGo = null
}
const EXIT_CODE_PLANTED = 113
const leave = (state: State, signal: string): void => {
  did.length = 0
  timers.length = 0
  process.exitCode = EXIT_CODE_PLANTED
  part.shutdownDaemon(state, needs, signal)
}
const happened = (): string[] => (process.exitCode === EXIT_CODE_PLANTED ? [...did] : [...did, `process.exitCode = ${shown(process.exitCode)}`])
const at = (what: string): number => did.findIndex(line => line.startsWith(what))

type Held = { step: string; leaves: string[] }
const GUARD = 'state.shuttingDown = true'
const BAIL = 'timer 15000'
const AT_ONCE: Held[] = [
  { step: 'stop the plane heal', leaves: ['stop the plane heal'] },
  { step: 'stop the armed-restart beat', leaves: ['stop the armed-restart beat'] },
  { step: 'stop the handover lock beat', leaves: ['stop the handover lock beat'] },
  { step: 'stop the sessionless beat', leaves: ['stop the sessionless beat'] },
  { step: 'stop the Saturn ticker', leaves: ['stop the Saturn ticker'] },
  { step: 'stop the host job sweep', leaves: ['stop the host job sweep'] },
  { step: 'yield the restart to a daemon that already serves', leaves: ['read who serves the plane'] },
  { step: 'mark the record stopping', leaves: ['mark the record stopping'] },
  { step: 'say it is leaving', leaves: ['debug: [daemon] received SIGTERM, shutting down', 'say: [daemon] SIGTERM — shutting down'] },
  { step: 'stop the owner watch', leaves: ['stop the owner watch', 'state.ownerWatch = undefined'] },
  { step: 'close the owner pipe', leaves: ['close the owner pipe', 'state.ownerPipe = undefined'] },
  { step: 'reap every rostered worker', leaves: ['list the roster', 'ledger long-lived reap concourse-w1 daemon-shutdown:SIGTERM', 'kill concourse-w1', 'ledger headless reap job-2 daemon-shutdown:SIGTERM', 'kill job-2'] },
]
const THEN: Held[] = [
  { step: 'close the control server', leaves: ['close the control server'] },
  { step: 'clear the control key', leaves: ['clear the control key'] },
  { step: 'clear the daemon record', leaves: ['clear the daemon record'] },
  { step: 'write the exit in the spawn ledger', leaves: ['ledger daemon exit daemon shutdown:SIGTERM'] },
  { step: 'mark the teardown complete', leaves: ['state.teardownComplete = true'] },
  { step: 'release the held reading', leaves: ['release the held reading'] },
  { step: 'spawn the successor when the restart stands', leaves: ['spawn the successor'] },
  { step: 'release the daemon lock', leaves: ['release the daemon lock', 'state.daemonLock = null'] },
  { step: 'wait for the runners that were asked to end', leaves: ['the asked runners settled'] },
  { step: 'wait for the trees of the runners that were killed', leaves: ['the killed trees settled within 5000 ms'] },
  { step: 'let the event loop go', leaves: ['let the event loop go'] },
  { step: 'resolve the run', leaves: ['resolve the run'] },
  { step: 'exit in 250 ms', leaves: ['timer 250'] },
]
const PLACES = [...AT_ONCE.map((held, i) => ({ ...held, place: `place ${i + 1} of the ${AT_ONCE.length} it does at once` })), ...THEN.map((held, i) => ({ ...held, place: `place ${i + 1} of the ${THEN.length} that follow` }))]
const KEPT = [GUARD, ...AT_ONCE.flatMap(held => held.leaves), ...THEN[0]!.leaves, BAIL, ...THEN.slice(1).flatMap(held => held.leaves)]
const WAITS = [
  { neighbour: 'close the control server', said: "the control server's close", how: 'the step awaits `state.controlServer?.close()` inside its try' },
  { neighbour: 'clear the control key', said: 'the clear of the control key', how: 'the step returns the promise of `clearControlKey().catch(() => {})`, so the runner of the second list awaits it' },
  { neighbour: 'clear the daemon record', said: 'the clear of the daemon record', how: 'the step returns the promise of `clearDaemonState().catch(() => {})`, so the runner of the second list awaits it' },
  { neighbour: 'release the daemon lock', said: 'the release of the daemon lock', how: 'the step awaits `state.daemonLock?.release().catch(() => {})` before it lets go of the field' },
  { neighbour: 'the asked runners settled', said: 'the wait for the runners that were asked to end', how: 'the step awaits `state.roster?.askedSettled()`' },
  { neighbour: 'the killed trees settled within 5000 ms', said: 'the wait for the trees of the runners that were killed', how: 'the step awaits `treeEndsSettled(KILLED_TREES_BOUND_MS)`' },
]
const FAILS = [
  { neighbour: 'close the control server', said: 'a control server whose close fails is logged and', also: ['debug: [daemon] error closing control server: Error: close the control server: planted failure'], how: 'keep the try around the close' },
  { neighbour: 'clear the control key', said: 'a control key whose clear fails is passed over and', also: [], how: 'keep the `.catch(() => {})` on `clearControlKey()`' },
  { neighbour: 'clear the daemon record', said: 'a daemon record whose clear fails is passed over and', also: [], how: 'keep the `.catch(() => {})` on `clearDaemonState()`' },
  { neighbour: 'release the daemon lock', said: 'a daemon lock whose release fails is passed over and', also: [], how: 'keep the `.catch(() => {})` on `state.daemonLock?.release()`' },
]

function readWayOut(ran: readonly string[], kept: readonly string[] = KEPT): string[] {
  const said: string[] = []
  for (const effect of ran) if (!kept.includes(effect)) said.push(`the way out did "${effect}", which no step this proof holds does — a step was added, or a step does more than it did: if the daemon is meant to do it on its way out, add it to the step's row in ${SELF} at the place it runs; if not, take it out of ${PART}`)
  for (const held of PLACES) {
    const missing = held.leaves.find(leaf => !ran.includes(leaf))
    if (missing !== undefined) said.push(`"${held.step}" (${held.place}) did not happen: nothing did "${missing}" — a step was dropped: if the daemon is meant to stop doing it on its way out, take its row out of ${SELF}; if not, put the step back in ${PART}`)
  }
  if (said.length > 0) return said
  const order = [...PLACES].sort((a, b) => ran.indexOf(a.leaves[0]!) - ran.indexOf(b.leaves[0]!))
  const first = order.findIndex((held, i) => held !== PLACES[i])
  if (first >= 0) {
    const came = order[first]!
    const pushed = PLACES[first]!
    const went = order.indexOf(pushed)
    return [`"${came.step}" ran at ${PLACES[first]!.place}, where this proof holds "${pushed.step}", and "${pushed.step}" ran at ${PLACES[went]!.place}, where it holds "${PLACES[went]!.step}" — two steps changed places: the order the daemon lets go in is behaviour; put the steps of ${PART} back in the order of ${SELF}, or change both in one commit and say what a daemon now does first`]
  }
  const off = Array.from({ length: Math.max(ran.length, kept.length) }).findIndex((_, i) => ran[i] !== kept[i])
  return off < 0 ? [] : [`the steps ran in their order and what they did does not stand as kept: "${ran[off] ?? '(nothing more)'}" is number ${off + 1} of what happened, where this proof holds "${kept[off] ?? '(nothing more)'}" — a step does its work in another order, twice, or beside the 15 s bail's place: put ${PART} back, or change the row in ${SELF} in the same commit and say what moved`]
}

const realError = console.error
const realExit = process.exit
const realTimeout = globalThis.setTimeout
const realInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realExitCode = process.exitCode
const unhandled = (reason: unknown): void => note(`a rejection nobody handled: ${reason instanceof Error ? reason.message : String(reason)}`)
console.error = (...args: unknown[]) => note(`say: ${args.map(String).join(' ')}`)
process.exit = ((code?: number) => note(`exit ${code}`)) as never
process.on('unhandledRejection', unhandled)
globalThis.setTimeout = ((run: () => void, ms?: number) => {
  const timer = { ms: ms ?? 0, run, unref: false }
  timers.push(timer)
  note(`timer ${ms}`)
  return {
    unref: () => {
      timer.unref = true
    },
  }
}) as never
globalThis.setInterval = ((_run: () => void, ms?: number) => {
  note(`interval ${ms}`)
  return { unref: () => {} }
}) as never
globalThis.setImmediate = (() => {
  note('immediate')
  return {}
}) as never
globalThis.clearInterval = ((timer: unknown) => {
  if (timer === KEEP_ALIVE) note('let the event loop go')
  else realClearInterval(timer as never)
}) as never

try {
  section('§0 the reader of the way out: a swap, a step added and a step dropped, each by its own line')
  {
    const swapped = (a: Held, b: Held): string[] => KEPT.flatMap(effect => (effect === a.leaves[0] ? b.leaves : effect === b.leaves[0] ? a.leaves : a.leaves.includes(effect) || b.leaves.includes(effect) ? [] : [effect]))
    const neighbours = readWayOut(swapped(AT_ONCE[7]!, AT_ONCE[8]!))
    check('what the proof holds reads clean', readWayOut(KEPT).length === 0, readWayOut(KEPT))
    check('two steps that changed places are named, each with the place it ran at, and the line says the order is behaviour', neighbours.length === 1 && neighbours[0]!.includes('"say it is leaving" ran at place 8 of the 12 it does at once, where this proof holds "mark the record stopping", and "mark the record stopping" ran at place 9 of the 12 it does at once, where it holds "say it is leaving"') && neighbours[0]!.includes('the order the daemon lets go in is behaviour'), neighbours)
    const across = readWayOut(swapped(AT_ONCE[11]!, THEN[0]!))
    check('a swap across the two lists is named the same way', across.length === 1 && across[0]!.includes('"close the control server" ran at place 12 of the 12 it does at once') && across[0]!.includes('"reap every rostered worker" ran at place 1 of the 13 that follow'), across)
    const dropped = readWayOut(KEPT.filter(effect => !THEN[6]!.leaves.includes(effect)))
    check('a step that left nothing is named with its place: dropped', dropped.length === 1 && dropped[0]!.startsWith('"spawn the successor when the restart stands" (place 7 of the 13 that follow) did not happen') && dropped[0]!.includes('a step was dropped'), dropped)
    const added = readWayOut([...KEPT.slice(0, 5), 'state.restartArmed = false', ...KEPT.slice(5)])
    check('something no step holds is named: added', added.length === 1 && added[0]!.startsWith('the way out did "state.restartArmed = false"') && added[0]!.includes('a step was added'), added)
    const twice = readWayOut([...KEPT, 'resolve the run'])
    check('a step that does its work twice is red', twice.length === 1 && twice[0]!.includes('does not stand as kept'), twice)
  }

  section('§1 the way out, in the order it lets go of what the boot took')
  {
    reset()
    const state = planted({ restartAfterTeardown: true })
    leave(state, 'SIGTERM')
    const atOnce = [...did]
    await settle()
    const differs = readWayOut(happened())
    check(`every one of the ${PLACES.length} steps runs, once, in the order the daemon has always left by (${KEPT.length} things done, read in the order they happen), and nothing else is done: no other call on the roster, the control server, the lock, the owner's watch and pipe or the breaker, no other timer, and the exit code is left as it was`, differs.length === 0, differs.join('\n      '))
    check('the shutdown road marks its record before it closes the socket', at('mark the record stopping') >= 0 && at('mark the record stopping') < at('close the control server'))
    check('the teardown reaps every rostered worker that has no outcome, each with its row in the spawn ledger first, and none that has ended', at('kill concourse-w1') > at('ledger long-lived reap concourse-w1') && at('kill job-2') > at('ledger headless reap job-2') && at('kill done-3') === -1)
    check('it waits for the runners it asked to end after it has struck them and before its own exit', at('kill job-2') < at('the asked runners settled') && at('the asked runners settled') < at('timer 250'))
    check('it waits for the trees of the runners it killed after the asked wait, with its bound of 5 s, and before it lets the event loop go', at('the asked runners settled') < at('the killed trees settled within 5000 ms') && at('the killed trees settled within 5000 ms') < at('let the event loop go'))
    check("it arms its own exit, 15 s out and unref'd, as it begins and outside the steps that can be held up", atOnce.includes('timer 15000') && !atOnce.includes('clear the control key') && timers.find(t => t.ms === 15000)?.unref === true, atOnce.slice(-3))
    check('the successor is spawned after the record is cleared and before the daemon lock is released', at('clear the daemon record') < at('spawn the successor') && at('spawn the successor') < at('release the daemon lock'))
    check('the daemon lock is released on the way out and the state lets go of it', at('release the daemon lock') >= 0 && state.daemonLock === null)
    check('the owner watch and pipe are let go, the teardown reads complete before the held reading is released, the run resolves before the exit timer', state.ownerWatch === undefined && state.ownerPipe === undefined && state.teardownComplete === true && at('state.teardownComplete = true') < at('release the held reading') && at('resolve the run') < at('timer 250'))
    timers.find(t => t.ms === 250)?.run()
    timers.find(t => t.ms === 15000)?.run()
    check('the exit after the teardown is 0; the bail, had it fired, is 1', did.slice(-2).join() === 'exit 0,exit 1', did.slice(-2))
  }

  section('§2 the guard, the restart that yields, the daemon with no control layer')
  {
    reset()
    const state = planted()
    leave(state, 'SIGINT')
    await settle()
    const once = did.length
    part.shutdownDaemon(state, needs, 'SIGTERM')
    await settle()
    check('a second call on a daemon already leaving does nothing', did.length === once && state.shuttingDown === true)
    check('with no restart standing no successor is spawned', at('spawn the successor') === -1)

    reset()
    const yielding = planted({ restartAfterTeardown: true })
    script.supersededBy = { pid: 777, buildTree: 'bbbbbbbbbbbb', alive: true }
    leave(yielding, 'restart-when-idle:armed')
    await settle()
    check('a daemon that already serves the plane cancels the restart after teardown, with its line, before the record is marked', yielding.restartAfterTeardown === false && at('spawn the successor') === -1 && at('state.restartAfterTeardown = false') > at('read who serves the plane') && at('say: [daemon] pid 777 (build bbbbbbbbbbbb) is already serving; exiting without spawning a successor') >= 0 && at('say: [daemon] pid 777') < at('mark the record stopping'), did)

    reset()
    const bare = planted({ controlServer: null, roster: null, daemonLock: null, restartAfterTeardown: true }, false)
    script.supersededBy = { pid: 777, buildTree: null, alive: true }
    leave(bare, 'SIGTERM')
    await settle()
    check('with the control layer off nothing of the plane is touched: no mark, no key, no record, and who serves the plane is not read', at('mark the record stopping') === -1 && at('clear the control key') === -1 && at('clear the daemon record') === -1 && at('read who serves the plane') === -1 && bare.restartAfterTeardown === true && at('spawn the successor') >= 0, did)
    check('the rest of the way out still runs to its exit timer', at('ledger daemon exit daemon shutdown:SIGTERM') >= 0 && at('let the event loop go') >= 0 && at('resolve the run') < at('timer 250'))
  }

  section('§3 what the way out waits for: each neighbour it awaits is held open, nothing after it has happened, it is let go, the rest follows')
  for (const wait of WAITS) {
    reset()
    script.held = wait.neighbour
    const state = planted({ restartAfterTeardown: true })
    leave(state, 'SIGTERM')
    await settle()
    const before = KEPT.slice(0, Math.max(KEPT.indexOf(wait.neighbour), KEPT.indexOf(BAIL)) + 1)
    const early = did.slice(before.length)
    check(`while ${wait.said} is held open nothing after it has happened`, letGo !== null && did.join('\n') === before.join('\n'), letGo === null ? `the way out did not reach "${wait.neighbour}": ${JSON.stringify(did.slice(-3))}` : early.length > 0 ? `the way out went on without waiting: it did ${early.map(effect => `"${effect}"`).join(', ')} before ${wait.said} had settled — in ${PART} ${wait.how}; a step whose promise is not handed back to the runner of the second list is started and not waited for` : `what happened up to there does not stand as kept: ${readWayOut(did, before).join(' | ') || JSON.stringify(did.slice(-3))}`)
    const open = letGo as (() => void) | null
    open?.()
    await settle()
    const differs = readWayOut(happened())
    check(`once ${wait.said} has settled the rest follows in its order, to the exit timer`, differs.length === 0 && at('timer 250') >= 0, differs.join('\n      '))
  }

  section('§4 a neighbour that fails: the way out goes on to its exit timer, as it always has')
  for (const fail of FAILS) {
    reset()
    script.fails = fail.neighbour
    const state = planted({ restartAfterTeardown: true })
    leave(state, 'SIGTERM')
    await settle()
    const kept = [...KEPT.slice(0, KEPT.indexOf(BAIL) + 1), ...fail.also, ...KEPT.slice(KEPT.indexOf(BAIL) + 1)]
    const differs = readWayOut(happened(), kept)
    const lost = did.find(effect => effect.startsWith('a rejection nobody handled'))
    const reached = did.filter(effect => effect !== lost)
    check(`${fail.said} the way out goes on: every step after it runs in its order, to the exit timer`, differs.length === 0 && at('timer 250') >= 0 && lost === undefined, lost !== undefined ? `the failure ended the way out there (${lost}): ${reached.length} of ${kept.length} things happened, the last "${reached.at(-1)}", and the exit timer was never armed — in ${PART} ${fail.how}: a daemon that cannot ${fail.neighbour} still does the rest and exits` : differs.join('\n      '))
  }

  section('§5 binding the way out: a stop asked before it is bound was kept, and is taken as it is bound')
  {
    reset()
    const asked: string[] = []
    const way = (signal: string): void => void asked.push(signal)
    const quiet = planted()
    did.length = 0
    check('with no stop asked, binding hands the way out back and takes it for nobody', part.bindWayOut(quiet, way) === way && asked.length === 0 && did.length === 0, [asked, did])
    const early = planted({ askedToLeave: 'control:shutdown' })
    did.length = 0
    check('a stop asked while the daemon booted is taken once, by its own name, as the way out is bound', part.bindWayOut(early, way) === way && asked.join() === 'control:shutdown' && did.length === 0, `${JSON.stringify(asked)} — a stop that the control server acknowledged before the boot bound the way out is kept in state.askedToLeave and taken by bindWayOut of ${PART}: without it the daemon answers the stop and goes on running`)
    const leaving = planted({ askedToLeave: 'SIGTERM', restartAfterTeardown: true })
    part.bindWayOut(leaving, signal => leave(leaving, signal))
    await settle()
    check('…and what is taken is the whole way out, to its exit timer', readWayOut(happened()).length === 0 && at('timer 250') >= 0, readWayOut(happened()))
  }

  section('§6 a step that throws: the daemon names the step, and the failure goes where it went')
  {
    reset()
    const early = planted({ restartAfterTeardown: true })
    early.stopSaturnTicker = () => {
      throw new Error('the planted failure')
    }
    did.length = 0
    let reached: unknown = null
    try {
      leave(early, 'SIGTERM')
    } catch (error) {
      reached = error
    }
    await settle()
    const first = KEPT.slice(1, KEPT.indexOf('stop the Saturn ticker'))
    check('a step of the first list that throws is named in the daemon\'s log, the throw reaches the caller, and nothing after it runs', reached instanceof Error && reached.message === 'the planted failure' && did.join(' · ') === [GUARD, ...first, 'say: [daemon] the way out failed at "stop the Saturn ticker": Error: the planted failure'].join(' · '), did.slice(-3))

    reset()
    const late = planted({ restartAfterTeardown: true })
    late.releaseHeldReading = () => {
      throw new Error('the planted failure')
    }
    leave(late, 'SIGTERM')
    await settle()
    const before = KEPT.slice(0, KEPT.indexOf('release the held reading'))
    check('a step of the second list that throws is named too, the way out ends there, and the rejection goes unhandled to the crash arm as it did', did.join(' · ') === [...before, 'say: [daemon] the way out failed at "release the held reading": Error: the planted failure', 'a rejection nobody handled: the planted failure'].join(' · '), did.slice(-3))

    reset()
    script.fails = 'the asked runners settled'
    const waiting = planted({ restartAfterTeardown: true })
    leave(waiting, 'SIGTERM')
    await settle()
    check('a wait that rejects is named by its step as well', did.includes('say: [daemon] the way out failed at "wait for the runners that were asked to end": Error: the asked runners settled: planted failure') && at('timer 250') === -1, did.slice(-3))
  }
} finally {
  console.error = realError
  process.exit = realExit
  globalThis.setTimeout = realTimeout
  globalThis.setInterval = realInterval
  globalThis.setImmediate = realImmediate
  globalThis.clearInterval = realClearInterval
  process.off('unhandledRejection', unhandled)
  process.exitCode = realExitCode
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-shutdown-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
