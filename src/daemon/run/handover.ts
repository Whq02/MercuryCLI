import { unlink } from 'fs/promises'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { acquireDaemonLock, currentVersion } from '../control/controlSocket.js'
import { daemonHomeStands } from '../control/daemonHome.js'
import { forwardFrame, predecessorSockPath } from '../control/handover.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { lockHeldByLivePidSync } from '../control/planeRecords.js'
import { MERCURY_DAEMON_PROTO } from '../control/protocol.js'
import { helperPidSocketsOnDisk } from '../control/status.js'
import type { periodicArmer } from './periodic.js'
import { successorRuntime } from './restart.js'
import type { DaemonRunState } from './state.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'
import { startTimeout } from '../../platform/async/timers.js'

const IDLE_PREDECESSOR_READS = 3
const FIRST_IDLE_SWEEP_MS = 1_000

interface HandoverNeeds {
  handoverPredecessor: number | null
  armPeriodic: ReturnType<typeof periodicArmer>
}

export function armHandoverBeats(state: DaemonRunState, { handoverPredecessor, armPeriodic }: HandoverNeeds): void {
  const { bootBuildTree } = state
  if (state.handover !== null) {
    const idleReads = new Map<number, number>()
    let sweepInflight = false
    const predecessors = state.handover
    const askIdlePredecessorsToLeave = async (): Promise<void> => {
      if (sweepInflight || state.planeServedByOther !== null || successorRuntime() !== null) return
      sweepInflight = true
      try {
        for (const pid of helperPidSocketsOnDisk()) {
          if (pid !== process.pid && !isProcessAlive(pid) && daemonHomeStands('the departed-helper sweep')) await unlink(predecessorSockPath(pid)).catch(passedOverAs(undefined))
        }
        for (const pid of predecessors.predecessorPids()) {
          if (predecessors.heldRunners(pid).size > 0) {
            idleReads.delete(pid)
            continue
          }
          const reply = await forwardFrame(predecessorSockPath(pid), JSON.stringify({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: currentVersion(), clientBuildTree: bootBuildTree }), 1500)
          if (!reply.ok || reply.op !== 'hello' || reply.pid !== pid || reply.live > 0 || !isProcessAlive(pid)) {
            idleReads.delete(pid)
            continue
          }
          const reads = (idleReads.get(pid) ?? 0) + 1
          idleReads.set(pid, reads)
          const holdsLock = state.daemonLock === null && lockHeldByLivePidSync() === pid
          if (reads < (holdsLock ? 1 : IDLE_PREDECESSOR_READS)) continue
          idleReads.delete(pid)
          console.error(`[daemon] the daemon this one took over from (pid ${pid}, v${reply.version}) holds no live session and has not left on its own — asking it to leave`)
          await forwardFrame(predecessorSockPath(pid), JSON.stringify({ op: 'shutdown', reapWorkers: false, forwarded: true }), 3000).catch(passedOverAs(undefined))
        }
      } finally {
        sweepInflight = false
      }
    }
    const sweepNow = (): void => {
      void askIdlePredecessorsToLeave().catch(e => logForDebugging(`[daemon] the idle-predecessor sweep failed (the next beat retries): ${e}`))
    }
    armPeriodic('the idle-predecessor sweep', sweepNow)
    startTimeout(sweepNow, FIRST_IDLE_SWEEP_MS).unref?.()
  }
  if (handoverPredecessor !== null && state.daemonLock === null) {
    let lockClaimInflight = false
    const lockBeat = (): void => {
      void (async () => {
        if (state.daemonLock !== null || lockClaimInflight) return
        if (lockHeldByLivePidSync() !== null) return
        lockClaimInflight = true
        try {
          const taken = await acquireDaemonLock()
          if (taken === null) return
          state.daemonLock = taken
          state.stopLockBeat?.()
          console.error(`[daemon] handover from pid ${handoverPredecessor}: the predecessor released the daemon lock — this daemon holds it now`)
        } finally {
          lockClaimInflight = false
        }
      })()
    }
    armPeriodic('the handover lock beat', lockBeat, () => {
      state.stopLockBeat = null
    })
  }
}
