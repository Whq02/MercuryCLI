#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-restart-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — the value above is what the part did; change src/daemon/run/restart.ts (restartWhenIdle, armedRestartBeat, successorRuntime, spawnSuccessorDaemon) until it does what the label says` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

type Runtime = { script: string; buildTree: string | null; version: string | null; layout: 'source' | 'release' }
type Spawned = { node: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: unknown[] } }
const OWN = '/builds/own/mercury.mjs'
const OTHER: Runtime = { script: '/builds/other/mercury.mjs', buildTree: 'bbbbbbbbbbbb', version: null, layout: 'source' }
const script = {
  deployed: { script: OWN, buildTree: 'aaaaaaaaaaaa', version: null, layout: 'source' } as Runtime | null,
  own: OWN,
  stored: false,
  alive: (_pid: number): boolean => true,
}
const spawned: Spawned[] = []
const said: string[] = []

const handover = await import('../../src/daemon/control/handover.ts')
const daemonBuild = await import('../../src/daemon/control/daemonBuild.ts')
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const auth = await import('../../src/models/sign-in/credentials/auth.ts')
const childProcess = await import('node:child_process')
const { currentVersion } = await import('../../src/daemon/control/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.ts')
const { STORED_TOKEN_SCRUB_VARS } = await import('../../src/platform/processes/subprocessEnv.ts')
mock.module('../../src/daemon/control/handover.ts', () => ({ ...handover, deployedRuntime: () => script.deployed }))
mock.module('../../src/daemon/control/daemonBuild.ts', () => ({ ...daemonBuild, selfScriptPath: () => script.own, resolveScriptPath: (path: string | undefined) => path ?? '', nodeForBuild: (dir: string) => `${dir}/node` }))
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({ ...ownerWatch, isProcessAlive: (pid: number) => script.alive(pid) }))
mock.module('../../src/models/sign-in/credentials/auth.ts', () => ({ ...auth, hasStoredOAuthToken: () => script.stored }))
mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: (node: string, args: string[], options: Spawned['options']) => {
    spawned.push({ node, args, options })
    return { pid: 9191, on: () => {}, unref: () => {} }
  },
}))

const restart = await import('../../src/daemon/run/restart.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

const counts = { live: 0, liveSessions: 0, read: 0, asked: 0 }
const shutdowns: string[] = []
const needs = {
  liveWorkers: () => {
    counts.read++
    return { live: counts.live, liveSessions: counts.liveSessions }
  },
  askLiveSessionsForFacts: () => ++counts.asked,
  requestShutdown: (signal: string) => void shutdowns.push(signal),
}
const fresh = (foreground = false): ReturnType<typeof makeDaemonRunState> => makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
const reset = (): void => {
  counts.live = 0
  counts.liveSessions = 0
  counts.read = 0
  counts.asked = 0
  shutdowns.length = 0
  spawned.length = 0
  said.length = 0
  script.deployed = { script: OWN, buildTree: 'aaaaaaaaaaaa', version: null, layout: 'source' }
  script.own = OWN
  script.stored = false
  script.alive = () => true
  delete process.env.MERCURY_DAEMON_SUCCESSOR_OF
}
const predecessor = (held: number, alive = true) => ({ alive: () => alive, predecessorPids: () => [777], heldRunners: () => new Set(Array.from({ length: held }, (_, i) => `concourse-w${i}`)) }) as never
const realError = console.error
console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))

try {
  section('§1 restartWhenIdle on the installed build: taken at once when idle, armed while anything lives or is being born')
  {
    reset()
    const idle = fresh()
    const taken = restart.restartWhenIdle(idle, needs, 'the operator')
    check('an idle daemon answers restarting and marks the restart to run after its teardown', taken.state === 'restarting' && taken.live === 0 && idle.restartAfterTeardown === true && idle.restartArmed === false, taken)
    check('the way out is asked for after the answer has left, not inside the call', shutdowns.length === 0)
    await tick()
    check('…by the name control:restart-when-idle', shutdowns.join() === 'control:restart-when-idle' && said.some(line => line.includes('restart requested by the operator — idle, re-executing as the deployed build')), said)

    reset()
    const live = fresh()
    counts.live = 2
    const armed = restart.restartWhenIdle(live, needs, 'the operator')
    await tick()
    check('G4 with live workers the restart is armed, nothing is shut down, and the arm returns the live count for its receipt', armed.state === 'armed' && armed.live === 2 && live.restartArmed === true && live.restartAfterTeardown === false && shutdowns.length === 0 && said.some(line => line.includes('restart armed by the operator — re-executes as the deployed build when the 2 live worker(s) finish')), { armed, said })

    reset()
    const born = fresh()
    born.birthsInFlight = 1
    const held = restart.restartWhenIdle(born, needs, 'the operator')
    await tick()
    check('the idle road arms while a session is being born, and says so', held.state === 'armed' && born.restartArmed === true && shutdowns.length === 0 && said.some(line => line.includes('when the 0 live worker(s) and 1 session(s) being born finish')), { held, said })

    reset()
    const onTerminal = fresh(true)
    const refused = restart.restartWhenIdle(onTerminal, needs, 'the operator')
    check('G4 a daemon on a terminal refuses: it is stopped there', refused.state === 'refused' && (refused.detail ?? '').includes('runs on a terminal') && onTerminal.restartArmed === false && onTerminal.restartAfterTeardown === false, refused)

    reset()
    process.env.MERCURY_DAEMON_SUCCESSOR_OF = '777'
    const young = fresh()
    const guarded = restart.restartWhenIdle(young, needs, 'the operator')
    await tick()
    check('G4 a successor younger than the storm guard refuses a second restart', guarded.state === 'refused' && shutdowns.length === 0 && young.restartAfterTeardown === false, guarded)
    const nearly = restart.restartWhenIdle({ ...fresh(), startedAt: Date.now() - 59_000 }, needs, 'the operator')
    const past = restart.restartWhenIdle({ ...fresh(), startedAt: Date.now() - 61_000 }, needs, 'the operator')
    await tick()
    check('the storm guard is one minute: a successor 59 s old still refuses, one 61 s old takes the restart', nearly.state === 'refused' && (nearly.detail ?? '').includes('came back unchanged 59s ago') && past.state === 'restarting' && shutdowns.join() === 'control:restart-when-idle', { nearly, past, shutdowns })
    check('E4b the storm-guard refusal names the version and the protocol and carries no bundle path', (guarded.detail ?? '').includes(`came back unchanged 0s ago (still v${currentVersion()}, protocol ${MERCURY_DAEMON_PROTO})`) && (guarded.detail ?? '').includes('deploy a new build first') && !(guarded.detail ?? '').includes(OWN), guarded.detail)
    script.deployed = null
    const noDeploy = restart.restartWhenIdle(fresh(), needs, 'the operator')
    check('E4b with nothing deployed the refusal says a restart runs this same build', (noDeploy.detail ?? '').includes('a restart runs this same build — deploy a new build first'), noDeploy.detail)
    delete process.env.MERCURY_DAEMON_SUCCESSOR_OF
  }

  section('§2 another build is installed: this daemon re-executes nothing; it leaves now, or when what it hosts has finished')
  {
    reset()
    script.deployed = OTHER
    const idle = fresh()
    const answer = restart.restartWhenIdle(idle, needs, 'the operator')
    check('E4 an idle daemon of another build is refused the restart, with words that name the installed tree and running version without promising a separate daemon', answer.state === 'refused' && (answer.detail ?? '') === `another build (tree bbbbbbbbbbbb) is installed — running v${currentVersion()}; this one leaves now, re-executing nothing` && !(answer.detail ?? '').includes('starts its own daemon'), answer)
    check('…asks its live sessions for their facts, and marks no restart after teardown', counts.asked === 1 && idle.restartAfterTeardown === false && idle.restartArmed === false)
    await tick()
    check('E4 …and then leaves by control:restart-when-idle', shutdowns.join() === 'control:restart-when-idle')

    reset()
    script.deployed = OTHER
    const live = fresh()
    counts.live = 1
    const armed = restart.restartWhenIdle(live, needs, 'the operator')
    await tick()
    check('with a live worker it arms, leaves nothing yet, and logs the installed/running/live state without promising a separate daemon', armed.state === 'armed' && armed.live === 1 && live.restartArmed === true && shutdowns.length === 0 && said.some(line => line.includes(`another build (tree bbbbbbbbbbbb) is installed — running v${currentVersion()}; this one leaves when its 1 live worker(s) finish, re-executing nothing`) && !line.includes('starts its own daemon')), { armed, said })

    reset()
    script.deployed = OTHER
    const born = fresh()
    born.birthsInFlight = 1
    const held = restart.restartWhenIdle(born, needs, 'the operator')
    await tick()
    check('…and so it does while a session is being born', held.state === 'armed' && shutdowns.length === 0)
    const behind = fresh()
    behind.handover = predecessor(0)
    check('…and while a predecessor still lives', restart.restartWhenIdle(behind, needs, 'the operator').state === 'armed' && behind.restartArmed === true)
  }

  section('§3 a screen heal, and a restart asked behind a predecessor')
  {
    reset()
    const healed = fresh()
    const answer = restart.restartWhenIdle(healed, needs, 'screen 4242')
    await tick()
    check('E4 a screen heal on the installed build is refused with the reopen words and nothing is armed', answer.state === 'refused' && (answer.detail ?? '').includes('this daemon runs the installed build (tree aaaaaaaaaaaa) and cannot become another build of the same version') && shutdowns.length === 0 && healed.restartArmed === false, answer)

    reset()
    const behind = fresh()
    behind.handover = predecessor(2)
    const armed = restart.restartWhenIdle(behind, needs, 'the operator')
    await tick()
    check('behind a predecessor that still hosts sessions the restart arms and names it and its sessions', armed.state === 'armed' && armed.detail === 'the daemon this one took over from (pid 777) still hosts 2 live sessions — the restart runs when they finish' && behind.restartArmed === true && shutdowns.length === 0, armed)
    const leaving = fresh()
    leaving.handover = predecessor(0)
    counts.live = 1
    counts.liveSessions = 1
    check("a predecessor that holds nothing is still leaving, and this daemon's own session is counted in the words", restart.restartWhenIdle(leaving, needs, 'the operator').detail === 'the daemon this one took over from (pid 777) is still leaving and this daemon hosts 1 live session — the restart runs when they finish')
    const gone = fresh()
    gone.handover = predecessor(0, false)
    counts.live = 0
    check('a predecessor that has gone holds nothing back', restart.restartWhenIdle(gone, needs, 'the operator').state === 'restarting')
  }

  section('§4 the armed beat: it reads the live count every beat and fires only when nothing lives, is being born or is hosted by a predecessor')
  {
    reset()
    const state = fresh()
    restart.armedRestartBeat(state, needs)
    check('a beat with nothing armed reads nothing', counts.read === 0 && shutdowns.length === 0)
    state.restartArmed = true
    counts.live = 1
    restart.armedRestartBeat(state, needs)
    counts.live = 2
    restart.armedRestartBeat(state, needs)
    check('the beat gates the re-exec on the live worker count, read again every beat: a session admitted after the arm holds it too', counts.read === 2 && shutdowns.length === 0 && state.restartArmed === true)
    counts.live = 0
    state.birthsInFlight = 1
    restart.armedRestartBeat(state, needs)
    check('the armed beat waits for a birth in flight as it waits for a live worker', shutdowns.length === 0 && state.restartArmed === true)
    state.birthsInFlight = 0
    state.handover = predecessor(1)
    restart.armedRestartBeat(state, needs)
    check('…and for a predecessor that still lives', shutdowns.length === 0 && state.restartArmed === true)
    state.planeServedByOther = { pid: 4, buildTree: 'bbbbbbbbbbbb', alive: true }
    script.alive = pid => pid !== 4
    restart.armedRestartBeat(state, needs)
    check('…also when the daemon that served the plane has died', shutdowns.length === 0)
    state.handover = null
    restart.armedRestartBeat(state, needs)
    check("the re-exec fires only once the live count reaches zero: the restart is marked, the arm is spent, the way out is asked for by the beat's name", shutdowns.join() === 'restart-when-idle:armed' && state.restartAfterTeardown === true && state.restartArmed === false && said.some(line => line.includes('armed restart — idle now, re-executing as the deployed build')), { shutdowns, said })
    restart.armedRestartBeat(state, needs)
    check('a restart already marked is not fired twice', shutdowns.length === 1)

    reset()
    script.deployed = OTHER
    const other = fresh()
    other.restartArmed = true
    restart.armedRestartBeat(other, needs)
    check('with another build installed the armed beat leaves and re-executes nothing', shutdowns.join() === 'restart-when-idle:armed' && other.restartAfterTeardown === false && other.restartArmed === false && said.some(line => line.includes('armed restart — idle now; another build (tree bbbbbbbbbbbb) is installed')), said)
  }

  section('§5 the successor: this same build, its own argv, environment and folder, the stored sign-in scrubbed')
  {
    reset()
    process.env.MERCURY_DAEMON_HANDOVER_FROM = '555'
    const pid = restart.spawnSuccessorDaemon()
    const made = spawned[0]
    check('E4 the daemon re-executes its own build: the real script path on the node beside it, then its own arguments', pid === 9191 && made !== undefined && made.node === '/builds/own/node' && JSON.stringify(made.args) === JSON.stringify([...process.execArgv, OWN, ...process.argv.slice(2)]), made)
    check('G6 the successor runs in this folder, detached, with this environment and the stamp of who it succeeds', made?.options.cwd === process.cwd() && made?.options.detached === true && made?.options.env?.MERCURY_DAEMON_SUCCESSOR_OF === String(process.pid) && made?.options.env?.MERCURY_CONFIG_DIR === home, made?.options.cwd)
    check('the handover stamp of this daemon is not handed down', made?.options.env?.MERCURY_DAEMON_HANDOVER_FROM === undefined)
    check("its output goes where this daemon's goes; it takes no terminal", JSON.stringify(made?.options.stdio) === JSON.stringify(['ignore', 'inherit', 'inherit']))
    check('the log names the pid, the script, the version and the node', said.some(line => line.includes(`successor spawned — pid 9191 runs ${OWN} (this same build, v${currentVersion()}) on /builds/own/node`)), said)
    delete process.env.MERCURY_DAEMON_HANDOVER_FROM

    reset()
    script.own = ''
    restart.spawnSuccessorDaemon()
    check('G6 with no script path of its own it re-executes its own argv as it stands', JSON.stringify(spawned[0]?.args) === JSON.stringify([...process.execArgv, ...process.argv.slice(1)]), spawned[0]?.args)

    reset()
    const token = STORED_TOKEN_SCRUB_VARS[0]!
    process.env[token] = 'a-token-of-the-parent'
    restart.spawnSuccessorDaemon()
    check('with no stored sign-in the environment is handed down as it is', spawned[0]?.options.env?.[token] === 'a-token-of-the-parent' && !said.some(line => line.includes('successor scrub')))
    reset()
    script.stored = true
    restart.spawnSuccessorDaemon()
    check('spawnSuccessorDaemon re-runs the gated scrub with the one-home set: a stored sign-in drops every token variable', STORED_TOKEN_SCRUB_VARS.every(name => spawned[0]?.options.env?.[name] === undefined), spawned[0]?.options.env?.[token])
    check('the successor scrub is receipted: the daemon says what it dropped and why', said.some(line => line.includes(`successor scrub — a stored sign-in exists; the successor re-resolves it (dropped: ${token}`)), said)
    delete process.env[token]
  }
} finally {
  console.error = realError
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-restart-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
