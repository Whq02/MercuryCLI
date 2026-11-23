import { lstatSync, readlinkSync, unlinkSync, writeSync } from 'node:fs'
import { unlink } from 'fs/promises'
import { basename } from 'path'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { localIpcDoorKind } from '../../platform/host-os/files.js'
import { treeEndsSettled } from '../../platform/processes/processGroup.js'
import { recordSpawnExit } from '../roster/spawnLedger.js'
import { parkAllConcourseSessions } from '../concourse-workers/concourseWorkers.js'
import { clearControlKey, clearDaemonState, controlKeyPath, controlSockPath, daemonDir, markDaemonStoppingSync } from '../control/controlSocket.js'
import { armDaemonHomeWatch } from '../control/daemonHome.js'
import { forwardFrame, predecessorSockPath } from '../control/handover.js'
import { supersededByLivePlaneOwnerSync } from '../control/planeRecords.js'
import type { DaemonRunState } from './state.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import { startImmediate, startTimeout, stopInterval } from '../../platform/async/timers.js'

const PREDECESSOR_SHUTDOWN_WAIT_MS = 6_000
const KILLED_TREES_BOUND_MS = 5_000

interface ShutdownNeeds {
  keepAlive: ReturnType<typeof setInterval>
  resolveShutdown: () => void
  spawnSuccessorDaemon: () => number | undefined
}

interface StopNeeds {
  requestShutdown: (signal: string) => void
}

interface WaysOutNeeds {
  shutdown: (signal: string) => void
  persistCrash: (err: unknown, label: string) => void
}

interface FailedBootNeeds {
  planeAnswer: (bootBuildTree: string | null) => Promise<{ pid: number; buildTree: string | null } | null>
  planeHeldLine: (holder: { pid: number; buildTree: string | null } | null) => string
}

interface WayOutStep {
  readonly name: string
  readonly run: (state: DaemonRunState, needs: ShutdownNeeds, signal: string) => void | Promise<void>
}

const WAY_OUT_AT_ONCE: readonly WayOutStep[] = [
  {
    name: 'stop the plane heal',
    run: state => {
      state.stopPlaneHeal?.()
    },
  },
  {
    name: 'stop the armed-restart beat',
    run: state => {
      state.stopArmedBeat?.()
    },
  },
  {
    name: 'stop the handover lock beat',
    run: state => {
      state.stopLockBeat?.()
    },
  },
  {
    name: 'stop the sessionless beat',
    run: state => {
      state.stopSessionlessBeat?.()
    },
  },
  {
    name: 'stop the Saturn ticker',
    run: state => {
      state.stopSaturnTicker?.()
    },
  },
  {
    name: 'stop the host job sweep',
    run: state => {
      state.stopHostJobs?.()
    },
  },
  {
    name: 'yield the restart to a daemon that already serves',
    run: state => {
      const supersededBy = state.controlEnabled ? supersededByLivePlaneOwnerSync() : null
      if (supersededBy !== null && state.restartAfterTeardown) {
        state.restartAfterTeardown = false
        console.error(`[daemon] pid ${supersededBy.pid} (build ${supersededBy.buildTree ?? 'unstamped'}) is already serving; exiting without spawning a successor`)
      }
    },
  },
  {
    name: 'mark the record stopping',
    run: state => {
      if (state.controlEnabled) markDaemonStoppingSync()
    },
  },
  {
    name: 'say it is leaving',
    run: (_state, _needs, signal) => {
      logForDebugging(`[daemon] received ${signal}, shutting down`)
      console.error(`[daemon] ${signal} — shutting down`)
    },
  },
  {
    name: 'stop the owner watch',
    run: state => {
      state.ownerWatch?.stop()
      state.ownerWatch = undefined
    },
  },
  {
    name: 'close the owner pipe',
    run: state => {
      state.ownerPipe?.close()
      state.ownerPipe = undefined
    },
  },
  {
    name: 'reap every rostered worker',
    run: (state, _needs, signal) => {
      if (state.roster) {
        for (const j of state.roster.list()) {
          if (!j.outcome) {
            recordSpawnExit({
              kind: j.via === 'runner' ? 'long-lived' : 'headless',
              event: 'reap',
              id: j.short,
              pid: j.pid,
              reason: `daemon-shutdown:${signal}`,
            })
            state.roster.kill(j.short)
          }
        }
      }
    },
  },
]

const WAY_OUT_THEN: readonly WayOutStep[] = [
  {
    name: 'close the control server',
    run: async state => {
      try {
        await state.controlServer?.close()
      } catch (e) {
        logForDebugging(`[daemon] error closing control server: ${e}`)
      }
    },
  },
  {
    name: 'clear the control key',
    run: state => (state.controlEnabled ? clearControlKey().catch(passedOver) : undefined),
  },
  {
    name: 'clear the daemon record',
    run: state => (state.controlEnabled ? clearDaemonState().catch(passedOver) : undefined),
  },
  {
    name: 'write the exit in the spawn ledger',
    run: (_state, _needs, signal) => {
      recordSpawnExit({
        kind: 'daemon',
        event: 'exit',
        id: 'daemon',
        pid: process.pid,
        reason: `shutdown:${signal}`,
      })
    },
  },
  {
    name: 'mark the teardown complete',
    run: state => {
      state.teardownComplete = true
    },
  },
  {
    name: 'release the held reading',
    run: state => {
      state.releaseHeldReading()
    },
  },
  {
    name: 'spawn the successor when the restart stands',
    run: (state, needs) => {
      if (state.restartAfterTeardown) needs.spawnSuccessorDaemon()
    },
  },
  {
    name: 'release the daemon lock',
    run: async state => {
      await state.daemonLock?.release().catch(passedOver)
      state.daemonLock = null
    },
  },
  {
    name: 'wait for the runners that were asked to end',
    run: async state => {
      await state.roster?.askedSettled()
    },
  },
  {
    name: 'wait for the trees of the runners that were killed',
    run: async () => {
      await treeEndsSettled(KILLED_TREES_BOUND_MS)
    },
  },
  {
    name: 'let the event loop go',
    run: (_state, needs) => {
      stopInterval(needs.keepAlive)
    },
  },
  {
    name: 'resolve the run',
    run: (_state, needs) => {
      needs.resolveShutdown()
    },
  },
  {
    name: 'exit in 250 ms',
    run: () => {
      startTimeout(() => process.exit(0), 250)
    },
  },
]

export function bindWayOut(state: DaemonRunState, shutdown: (signal: string) => void): (signal: string) => void {
  if (state.askedToLeave !== null) shutdown(state.askedToLeave)
  return shutdown
}

function failedAt(step: WayOutStep, e: unknown): never {
  console.error(`[daemon] the way out failed at "${step.name}": ${e}`)
  throw e
}

function leaveWatchesToProcessEnd(): void {
  try {
    const watches = require('../../platform/processes/watchRoot.js') as typeof import('../../platform/processes/watchRoot.js')
    watches.leaveFileWatchesToProcessEnd()
  } catch (e) {
    logForDebugging(`[daemon] the file watches were not left to the process end: ${e}`)
  }
}

export function shutdownDaemon(state: DaemonRunState, needs: ShutdownNeeds, signal: string): void {
  if (state.shuttingDown) return
  state.shuttingDown = true
  leaveWatchesToProcessEnd()
  for (const step of WAY_OUT_AT_ONCE) {
    try {
      void step.run(state, needs, signal)
    } catch (e) {
      failedAt(step, e)
    }
  }
  void (async () => {
    for (const step of WAY_OUT_THEN) {
      try {
        const held = step.run(state, needs, signal)
        if (held !== undefined) await held
      } catch (e) {
        failedAt(step, e)
      }
    }
  })()
  const bail = startTimeout(() => process.exit(1), 15_000)
  bail.unref?.()
}

export async function stopVerb(state: DaemonRunState, { requestShutdown }: StopNeeds, reapWorkers: boolean, forwardedFromPlane: boolean): Promise<{ reaped: number; workers: ReturnType<NonNullable<DaemonRunState['roster']>['liveWorkerFacts']> }> {
  const { roster, handover } = state
  const workers: ReturnType<NonNullable<typeof roster>['liveWorkerFacts']> = []
  if (reapWorkers && roster) {
    const live = roster.liveWorkerFacts()
    const parked = parkAllConcourseSessions('daemon:stop', roster, undefined, { reason: 'parked — the daemon was stopped', afterTurn: false })
    console.error(`[daemon] stop parks every active session: parked ${parked.parked.length}, released ${parked.released.length} newborn(s), skipped ${parked.skipped.length}${parked.refused.length > 0 ? `, refused ${parked.refused.join(', ')}` : ''}`)
    for (const w of live) {
      if (roster.kill(w.short)) workers.push(w)
    }
  }
  const forwarded = forwardedFromPlane
    ? []
    : await Promise.all(
        (handover?.predecessorPids() ?? []).map(pid => forwardFrame(predecessorSockPath(pid), JSON.stringify({ op: 'shutdown', reapWorkers, forwarded: true }), PREDECESSOR_SHUTDOWN_WAIT_MS).catch(e => {
          console.error(`[daemon] the earlier daemon pid ${pid} did not answer the stop and may still be running: ${e instanceof Error ? e.message : String(e)}`)
          return null
        })),
      )
  let reaped = workers.length
  for (const reply of forwarded) {
    if (reply === null || !reply.ok || reply.op !== 'shutdown') continue
    reaped += reply.reaped
    workers.push(...(reply.workers ?? []))
  }
  startImmediate(() => requestShutdown('control:shutdown'))
  return { reaped, workers }
}

export function armWaysOut({ shutdown, persistCrash }: WaysOutNeeds): void {
  armDaemonHomeWatch(daemonDir(), where => {
    shutdown(`home-gone: the daemon directory ${daemonDir()} is gone, noticed at ${where}; the world ended and nothing more is written`)
  })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  process.on('SIGBREAK', () => shutdown('SIGBREAK'))

  const crashShutdown = (label: string, err: unknown): void => {
    console.error(`[daemon] ${label} — reaping workers + control socket, then exiting:`, err)
    persistCrash(err, label)
    try {
      shutdown(label)
    } catch (e) {
      logForDebugging(`[daemon] crash shutdown threw: ${e}`)
    }
    const bail = startTimeout(() => process.exit(1), 2000)
    bail.unref?.()
  }
  process.on('uncaughtException', err => crashShutdown('uncaughtException', err))
  process.on('unhandledRejection', reason => crashShutdown('unhandledRejection', reason))
}

function unpublishOwnPlane(): void {
  const plane = controlSockPath()
  try {
    if (lstatSync(plane, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(plane) === basename(predecessorSockPath(process.pid))) unlinkSync(plane)
  } catch (e) {
    logForDebugging(`[daemon] the published ${plane} could not be removed: ${e}`)
  }
}

export async function giveHomeBack(state: DaemonRunState, { planeAnswer, planeHeldLine }: FailedBootNeeds, e: unknown): Promise<void> {
  const { bootBuildTree } = state
  console.error(`[daemon] ${GLYPH.warn} control layer FAILED to start at "${state.bootStep}": ${e}`)
  logForDebugging(`[daemon] control layer failed to start — giving the home back and exiting: ${e}`)
  state.controlServer = null
  const holder = await planeAnswer(bootBuildTree).catch(passedOverAs(null))
  try {
    writeSync(2, `[daemon] ${planeHeldLine(holder)}\n`)
  } catch (error) { passedOver(error) }
  await unlink(controlKeyPath()).catch(passedOver)
  await clearDaemonState()
  if (localIpcDoorKind() === 'unix-socket') {
    unpublishOwnPlane()
    await unlink(predecessorSockPath(process.pid)).catch(passedOver)
  }
  await state.daemonLock?.release().catch(passedOver)
  state.daemonLock = null
  state.teardownComplete = true
  process.exit(1)
}
