import { spawn } from 'node:child_process'
import { dirname } from 'path'
import { hasStoredOAuthToken } from '../../models/sign-in/credentials/auth.js'
import { STORED_TOKEN_SCRUB_VARS } from '../../platform/processes/subprocessEnv.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { flagEnv, flagPair, flagSpellings } from '../../platform/substrate/flagRegistry.js'
import { stampSpawnReceipt } from '../../platform/substrate/envStamps.js'
import { MERCURY_DAEMON_PROTO } from '../control/protocol.js'
import { currentVersion } from '../control/controlSocket.js'
import { deployedRuntime, type HandoverStateV1 } from '../control/handover.js'
import { OTHER_BUILD_WAY_OUT, REOPEN_WORDS } from '../control/handshake.js'
import { nodeForBuild, resolveScriptPath, selfScriptPath } from '../control/daemonBuild.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { isScreenHealAsk } from '../control/verbs.js'
import type { DaemonRunState } from './state.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { startImmediate } from '../../platform/async/timers.js'

const RESTART_STORM_GUARD_MS = 60_000
export const ARMED_RESTART_BEAT_MS = 4_000

interface RestartNeeds {
  liveWorkers: () => { live: number; liveSessions: number }
  askLiveSessionsForFacts: () => number
  requestShutdown: (signal: string) => void
}

export function restartWhenIdle(state: DaemonRunState, { liveWorkers, askLiveSessionsForFacts, requestShutdown }: RestartNeeds, by: string): { state: 'refused' | 'armed' | 'restarting'; live: number; detail?: string } {
  const counts = liveWorkers()
  const { live } = counts
  if (state.foreground) {
    return { state: 'refused' as const, live, detail: 'runs on a terminal: stop it there (ctrl-c) and run `mercury daemon` again' }
  }
  const installed = deployedRuntime()
  const other = successorRuntime()
  if (other !== null) {
    const detail = otherBuildInstalledDetail(other, live)
    console.error(`[daemon] restart asked by ${by} — ${detail}`)
    askLiveSessionsForFacts()
    if (live > 0 || state.birthsInFlight > 0 || state.handover?.alive()) {
      state.restartArmed = true
      return { state: 'armed' as const, live }
    }
    startImmediate(() => requestShutdown('control:restart-when-idle'))
    return { state: 'refused' as const, live, detail }
  }
  if (installed !== null && isScreenHealAsk(by)) {
    console.error(`[daemon] restart asked by ${by} — refused: ${reopenDetail(installed)}`)
    return { state: 'refused' as const, live, detail: reopenDetail(installed) }
  }
  if (state.handover !== null && state.handover.alive()) {
    const detail = predecessorsStillHostingDetail(state.handover, counts)
    state.restartArmed = true
    console.error(`[daemon] restart armed by ${by} — ${detail}`)
    return { state: 'armed' as const, live, detail }
  }
  if (flagEnv('MERCURY_DAEMON_SUCCESSOR_OF') && Date.now() - state.startedAt < RESTART_STORM_GUARD_MS) {
    return {
      state: 'refused' as const,
      live,
      detail: unchangedSuccessorDetail(Math.round((Date.now() - state.startedAt) / 1000)),
    }
  }
  if (live > 0 || state.birthsInFlight > 0) {
    state.restartArmed = true
    console.error(`[daemon] restart armed by ${by} — re-executes as the deployed build when the ${live} live worker(s)${state.birthsInFlight > 0 ? ` and ${state.birthsInFlight} session(s) being born` : ''} finish`)
    return { state: 'armed' as const, live }
  }
  console.error(`[daemon] restart requested by ${by} — idle, re-executing as the deployed build`)
  state.restartAfterTeardown = true
  startImmediate(() => requestShutdown('control:restart-when-idle'))
  return { state: 'restarting' as const, live: 0 }
}

export function armedRestartBeat(state: DaemonRunState, { liveWorkers, requestShutdown }: Pick<RestartNeeds, 'liveWorkers' | 'requestShutdown'>): void {
  if (!state.restartArmed || state.restartAfterTeardown) return
  if (liveWorkers().live > 0 || state.birthsInFlight > 0) return
  if (state.handover?.alive() && (state.planeServedByOther === null || !isProcessAlive(state.planeServedByOther.pid))) return
  state.restartArmed = false
  const other = successorRuntime()
  if (other !== null) {
    console.error(`[daemon] armed restart — idle now; ${otherBuildInstalledDetail(other, 0)}`)
    requestShutdown('restart-when-idle:armed')
    return
  }
  state.restartAfterTeardown = true
  console.error('[daemon] armed restart — idle now, re-executing as the deployed build')
  requestShutdown('restart-when-idle:armed')
}

export function successorRuntime(): ReturnType<typeof deployedRuntime> {
  const deployed = deployedRuntime()
  if (deployed === null) return null
  const own = selfScriptPath()
  return own !== '' && resolveScriptPath(deployed.script) === own ? null : deployed
}

function installedWords(runtime: NonNullable<ReturnType<typeof deployedRuntime>>): string {
  return runtime.version !== null && runtime.version !== currentVersion() ? `v${runtime.version}` : `tree ${runtime.buildTree ?? 'unstamped'}`
}

function reopenDetail(installed: NonNullable<ReturnType<typeof deployedRuntime>>): string {
  if (installed.version !== null && installed.version !== currentVersion()) {
    return `${REOPEN_WORDS} — a newer Mercury (${installedWords(installed)}) is installed and this daemon already runs it`
  }
  return `this daemon runs the installed build (${installedWords(installed)}) and cannot become another build of the same version — ${OTHER_BUILD_WAY_OUT}`
}

function otherBuildInstalledDetail(other: NonNullable<ReturnType<typeof deployedRuntime>>, live: number): string {
  const leaves = live > 0 ? `this one leaves when its ${live} live worker(s) finish, re-executing nothing` : 'this one leaves now, re-executing nothing'
  return `another build (${installedWords(other)}) is installed — running v${currentVersion()}; ${leaves}`
}

function liveSessionWords(n: number): string {
  return `${n} live session${n === 1 ? '' : 's'}`
}

function predecessorsStillHostingDetail(state: Pick<HandoverStateV1, 'predecessorPids' | 'heldRunners'>, own: { live: number; liveSessions: number }): string {
  const rows = state.predecessorPids().map(pid => ({ pid, held: state.heldRunners(pid).size }))
  const theirs = rows.reduce((n, row) => n + row.held, 0)
  const one = rows.length === 1
  const who = one
    ? `the daemon this one took over from (pid ${rows[0]!.pid})`
    : `the daemons this one took over from (${rows.map(row => `pid ${row.pid}: ${row.held > 0 ? liveSessionWords(row.held) : 'leaving'}`).join(', ')})`
  const hosting = theirs > 0 ? `still ${one ? 'hosts' : 'host'} ${liveSessionWords(theirs)}` : `${one ? 'is' : 'are'} still leaving`
  const mine = own.live === 0 ? '' : ` and this daemon ${own.liveSessions === own.live ? `hosts ${liveSessionWords(own.live)}` : `runs ${own.live} live worker${own.live === 1 ? '' : 's'}`}`
  const when = theirs > 0 || own.live > 0 ? 'when they finish' : one ? 'when it has gone' : 'when they have gone'
  return `${who} ${hosting}${mine} — the restart runs ${when}`
}

function unchangedSuccessorDetail(ageSeconds: number): string {
  const deployed = deployedRuntime()
  const still = `came back unchanged ${ageSeconds}s ago (still v${currentVersion()}, protocol ${MERCURY_DAEMON_PROTO})`
  if (deployed === null) return `${still}: a restart runs this same build — deploy a new build first`
  if (deployed.layout === 'release') {
    return `${still}: the install's current version is still v${deployed.version ?? currentVersion()} — a restart runs this same build`
  }
  return `${still}: the deployed build is still this one — deploy a new build first`
}

export function spawnSuccessorDaemon(): number | undefined {
  try {
    const env: NodeJS.ProcessEnv = { ...hostEnv(), ...flagPair('MERCURY_DAEMON_SUCCESSOR_OF', String(process.pid)) }
    for (const spelling of flagSpellings('MERCURY_DAEMON_HANDOVER_FROM')) delete env[spelling]
    stampSpawnReceipt(env, ['MERCURY_DAEMON_SUCCESSOR_OF'])
    if (hasStoredOAuthToken()) {
      const stripped: string[] = []
      for (const k of STORED_TOKEN_SCRUB_VARS) {
        if (env[k] !== undefined) stripped.push(k)
        delete env[k]
      }
      if (stripped.length > 0) {
        console.error(`[daemon] successor scrub — a stored sign-in exists; the successor re-resolves it (dropped: ${stripped.join(', ')})`)
      }
    }
    const script = selfScriptPath()
    const node = nodeForBuild(script ? dirname(script) : '')
    const args = script ? [...process.execArgv, script, ...process.argv.slice(2)] : [...process.execArgv, ...process.argv.slice(1)]
    const child = spawn(node, args, {
      cwd: process.cwd(),
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', e => logForDebugging(`[daemon] successor spawn error (ignored): ${e}`))
    child.unref()
    console.error(`[daemon] successor spawned — pid ${child.pid} runs ${script || process.argv[1] || '?'} (this same build, v${currentVersion()}) on ${node}`)
    return child.pid
  } catch (e) {
    console.error(`[daemon] successor spawn failed — the next screen starts a daemon: ${e}`)
    return undefined
  }
}
