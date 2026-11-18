import { logForDebugging } from '../../utils/debug.js'
import { recordSpawnExit } from '../../utils/spawnLedger.js'
import { clearControlKey, clearDaemonState, markDaemonStoppingSync } from '../controlSocket.js'
import { supersededByLivePlaneOwnerSync } from '../planeRecords.js'
import type { DaemonRunState } from './state.js'

interface ShutdownNeeds {
  keepAlive: ReturnType<typeof setInterval>
  resolveShutdown: () => void
  spawnSuccessorDaemon: () => number | undefined
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
    run: state => (state.controlEnabled ? clearControlKey().catch(() => {}) : undefined),
  },
  {
    name: 'clear the daemon record',
    run: state => (state.controlEnabled ? clearDaemonState().catch(() => {}) : undefined),
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
      await state.daemonLock?.release().catch(() => {})
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
    name: 'let the event loop go',
    run: (_state, needs) => {
      clearInterval(needs.keepAlive)
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
      setTimeout(() => process.exit(0), 250)
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

export function shutdownDaemon(state: DaemonRunState, needs: ShutdownNeeds, signal: string): void {
  if (state.shuttingDown) return
  state.shuttingDown = true
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
  const bail = setTimeout(() => process.exit(1), 15_000)
  bail.unref?.()
}
