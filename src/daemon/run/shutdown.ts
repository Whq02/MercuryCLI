import { logForDebugging } from '../../utils/debug.js'
import { recordSpawnExit } from '../../utils/spawnLedger.js'
import { clearControlKey, clearDaemonState, markDaemonStoppingSync } from '../controlSocket.js'
import { supersededByLivePlaneOwnerSync } from '../planeRecords.js'
import type { DaemonRunState } from './state.js'

export interface ShutdownNeeds {
  keepAlive: ReturnType<typeof setInterval>
  resolveShutdown: () => void
  spawnSuccessorDaemon: () => number | undefined
}

export function shutdownDaemon(state: DaemonRunState, { keepAlive, resolveShutdown, spawnSuccessorDaemon }: ShutdownNeeds, signal: string): void {
  if (state.shuttingDown) return
  state.shuttingDown = true
  state.stopPlaneHeal?.()
  state.stopArmedBeat?.()
  state.stopLockBeat?.()
  state.stopSessionlessBeat?.()
  state.stopSaturnTicker?.()
  state.stopHostJobs?.()
  const supersededBy = state.controlEnabled ? supersededByLivePlaneOwnerSync() : null
  if (supersededBy !== null && state.restartAfterTeardown) {
    state.restartAfterTeardown = false
    console.error(`[daemon] pid ${supersededBy.pid} (build ${supersededBy.buildTree ?? 'unstamped'}) is already serving; exiting without spawning a successor`)
  }
  if (state.controlEnabled) markDaemonStoppingSync()
  logForDebugging(`[daemon] received ${signal}, shutting down`)
  console.error(`[daemon] ${signal} — shutting down`)
  state.ownerWatch?.stop()
  state.ownerWatch = undefined
  state.ownerPipe?.close()
  state.ownerPipe = undefined
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
  void (async () => {
    try {
      await state.controlServer?.close()
    } catch (e) {
      logForDebugging(`[daemon] error closing control server: ${e}`)
    }
    if (state.controlEnabled) await clearControlKey().catch(() => {})
    if (state.controlEnabled) await clearDaemonState().catch(() => {})
    recordSpawnExit({
      kind: 'daemon',
      event: 'exit',
      id: 'daemon',
      pid: process.pid,
      reason: `shutdown:${signal}`,
    })
    state.teardownComplete = true
    state.releaseHeldReading()
    if (state.restartAfterTeardown) spawnSuccessorDaemon()
    const daemonLock = state.daemonLock
    await daemonLock?.release().catch(() => {})
    state.daemonLock = null
    await state.roster?.askedSettled()
    clearInterval(keepAlive)
    resolveShutdown()
    setTimeout(() => process.exit(0), 250)
  })()
  const bail = setTimeout(() => process.exit(1), 15_000)
  bail.unref?.()
}
