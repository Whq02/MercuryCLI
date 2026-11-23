import { logForDebugging } from '../../platform/logs/debugLog.js'
import { pollUntil } from '../../platform/async/deadline.js'
import {
  nextLiveCockpitOwner,
  PARK_DRAIN_CUT_REASON,
  parkAllConcourseSessions,
  parkConcourseSession,
  pendingParkRequests,
  readSessionWorkers,
  withdrawParkRequestsBy,
} from '../concourse-workers/concourseWorkers.js'
import { readDaemonState, writeDaemonState } from '../control/controlSocket.js'
import { sessionParkDrainMs } from '../control/idleRetirement.js'
import { armOwnerPipe, getProcessStartTokenAsync, isProcessAlive, parseOwnerFd, startOwnerWatch } from '../control/ownerWatch.js'
import { decideSessionlessExit } from '../control/sessionlessExit.js'
import type { DaemonRunState } from './state.js'
import { errorMessage } from '../../platform/errors/errors.js'

interface OwnerNeeds {
  shutdown: (signal: string) => void
}

interface SessionlessNeeds {
  liveWorkers: () => { live: number }
  requestShutdown: (signal: string) => void
}

export function markHosted(state: DaemonRunState): void {
  if (!state.sessionless.hosted) state.sessionless = { ...state.sessionless, hosted: true }
}

function passOwnership(state: DaemonRunState, needs: OwnerNeeds, next: number): void {
  state.currentOwnerPid = next
  void readDaemonState()
    .then(rec => (rec && rec.pid === process.pid ? writeDaemonState({ ...rec, ownerPid: next }) : undefined))
    .catch(e => console.error(`[daemon] ownership passed to the live cockpit pid ${next}, but the daemon record was not updated and still names the previous owner: ${errorMessage(e)}`))
  void armOwnerWatch(state, needs, next, false)
}

async function parkAllThenShutdown(state: DaemonRunState, needs: OwnerNeeds, signal: string): Promise<void> {
  if (state.orphanParking || state.shuttingDown) return
  state.orphanParking = true
  try {
    const startedDrain = Date.now()
    const receipt = parkAllConcourseSessions(`daemon:${signal}`, state.roster ?? undefined)
    console.error(
      `[daemon] the screen is gone — parking every active session: parked ${receipt.parked.length}, draining ${receipt.draining.length} (finishing their turns), released ${receipt.released.length} newborn(s), skipped ${receipt.skipped.length}${receipt.refused.length > 0 ? `, refused ${receipt.refused.join(', ')}` : ''}`,
    )
    const ceilingMs = sessionParkDrainMs()
    const screenCameBack = (): boolean => {
      const next = state.shuttingDown ? undefined : nextLiveCockpitOwner(null, undefined, startedDrain)
      if (next === undefined) return false
      const kept = withdrawParkRequestsBy(`daemon:${signal}`, receipt.draining)
      state.orphanParking = false
      passOwnership(state, needs, next)
      console.error(`[daemon] the screen came back inside the drain — ownership passes to the live cockpit pid ${next}; the daemon stays up${kept.length > 0 ? ` and ${kept.join(', ')} ${kept.length === 1 ? 'keeps its turn' : 'keep their turns'} (the park asked at the reap is withdrawn)` : ''}`)
      return true
    }
    let firstLook = true
    const remainingMs = Math.max(0, ceilingMs - (Date.now() - startedDrain))
    const calledOff = await pollUntil(
      () => {
        if (!firstLook && screenCameBack()) return true
        firstLook = false
        if (pendingParkRequests().length === 0) return false
        return undefined
      },
      1000,
      remainingMs,
      () => false,
    )
    if (calledOff) return
    for (const short of pendingParkRequests()) {
      const rec = readSessionWorkers()[short]
      if (rec === undefined) continue
      const cut = parkConcourseSession(rec.sessionId, `daemon:${signal}`, state.roster ?? undefined, undefined, { afterTurn: false, reason: PARK_DRAIN_CUT_REASON })
      console.error(`[daemon] ${short} was still mid-turn at the drain ceiling — ${cut.outcome === 'applied' ? 'its turn is cut and it parks' : cut.outcome}`)
    }
  } catch (e) {
    logForDebugging(`[daemon] park-all at the orphan reap threw (ignored — shutting down): ${e}`)
  }
  needs.shutdown(signal)
}

export async function armOwnerWatch(state: DaemonRunState, needs: OwnerNeeds, pid: number, withPipe: boolean): Promise<void> {
  state.ownerWatch?.stop()
  state.ownerPipe?.close()
  state.ownerPipe = undefined
  const ownerStartToken = await getProcessStartTokenAsync(pid)
  if (state.shuttingDown || state.currentOwnerPid !== pid) return
  state.ownerWatch = startOwnerWatch({
    ownerPid: pid,
    baselineToken: ownerStartToken,
    log: line => console.error(line),
    onOrphan: why => {
      state.ownerPipe?.close()
      const next = nextLiveCockpitOwner(pid)
      if (next !== undefined) {
        passOwnership(state, needs, next)
        console.error(`[daemon] owner pid ${pid} gone (${why}) — ownership passes to the live cockpit pid ${next}; the daemon stays up`)
        return
      }
      console.error(`[daemon] owner pid ${pid} gone (${why}) — no live cockpit remains: parking every active session, then self-reaping (orphaned auto-start)`)
      void parkAllThenShutdown(state, needs, 'owner-orphaned')
    },
  })
  if (withPipe) {
    const ownerFd = parseOwnerFd()
    if (ownerFd !== null) {
      state.ownerPipe = armOwnerPipe(ownerFd, () => state.ownerWatch?.ownerPipeClosed(), line => console.error(line))
      if (!state.ownerPipe.armed) {
        console.error(`[daemon] owner pipe not armed (${state.ownerPipe.why ?? 'unknown'}) — the liveness beat and the minute identity probe watch alone`)
      }
    }
  }
}

export function makeSessionlessBeat(state: DaemonRunState, { liveWorkers, requestShutdown }: SessionlessNeeds): () => void {
  let lastHold = ''
  return () => {
    if (state.restartAfterTeardown) return
    const live = liveWorkers().live
    const superseded = state.planeServedByOther !== null && isProcessAlive(state.planeServedByOther.pid)
    const candidate = live === 0 && state.birthsInFlight === 0 && (state.sessionless.hosted || superseded) && !state.foreground && (superseded || !(state.persist || state.currentOwnerPid === null))
    const scheduled = candidate && !superseded ? Object.values(readSessionWorkers()).some(r => r.endedAt === undefined && ((r.schedules?.length ?? 0) > 0 || (r.heldFires?.length ?? 0) > 0)) : false
    const verdict = decideSessionlessExit(state.sessionless, {
      live,
      birthsInFlight: state.birthsInFlight,
      superseded,
      persist: state.persist || state.currentOwnerPid === null,
      foreground: state.foreground,
      scheduled,
      now: Date.now(),
    })
    state.sessionless = verdict.state
    if (!verdict.exit) {
      if (candidate && verdict.hold !== lastHold && !verdict.hold.startsWith('empty for')) {
        lastHold = verdict.hold
        console.error(`[daemon] no session is hosted here — held by: ${verdict.hold}`)
      }
      return
    }
    console.error(`[daemon] ${verdict.why} — shutting down`)
    requestShutdown('sessionless')
  }
}
