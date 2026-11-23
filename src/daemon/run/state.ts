import type { DaemonBreaker } from '../control/daemonBreaker.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { ControlServerHandle } from '../control/controlServer.js'
import type { DaemonLock } from '../control/controlSocket.js'
import type { HandoverStateV1 } from '../control/handover.js'
import { parseOwnerPid, type OwnerPipeHandleV1, type OwnerWatchHandleV1 } from '../control/ownerWatch.js'
import type { PlaneOwnerV1 } from '../control/planeRecords.js'
import type { TaskRoster } from '../roster/roster.js'
import { initialSessionlessState } from '../control/sessionlessExit.js'

interface DaemonRunBootFacts {
  dir: string
  bootBuildTree: string | null
  foreground: boolean
  breaker: DaemonBreaker
  maxInflight: number
  controlEnabled: boolean
}

export interface DaemonRunState extends Readonly<DaemonRunBootFacts> {
  readonly persist: boolean
  readonly startedAt: number
  readonly readyPromise: Promise<void>
  readonly wakeReady: () => void
  bootStep: string
  ready: boolean
  roster: TaskRoster | null
  handover: HandoverStateV1 | null
  daemonLock: DaemonLock | null
  controlServer: ControlServerHandle | null
  releaseHeldReading: () => void
  stopPlaneHeal: (() => void) | null
  stopArmedBeat: (() => void) | null
  stopLockBeat: (() => void) | null
  stopSessionlessBeat: (() => void) | null
  stopSaturnTicker: (() => void) | null
  stopHostJobs: (() => void) | null
  restartArmed: boolean
  restartAfterTeardown: boolean
  planeServedByOther: PlaneOwnerV1 | null
  birthsInFlight: number
  sessionless: ReturnType<typeof initialSessionlessState>
  currentOwnerPid: number | null
  ownerWatch: OwnerWatchHandleV1 | undefined
  ownerPipe: OwnerPipeHandleV1 | undefined
  orphanParking: boolean
  askedToLeave: string | null
  shuttingDown: boolean
  teardownComplete: boolean
}

export function makeDaemonRunState(boot: DaemonRunBootFacts): DaemonRunState {
  const sessionless = initialSessionlessState()
  const currentOwnerPid = parseOwnerPid()
  const persist = isEnvTruthy(flagEnv('MERCURY_DAEMON_PERSIST'))
  let wakeReady: () => void = () => {}
  const readyPromise = new Promise<void>(resolve => {
    wakeReady = resolve
  })
  const startedAt = Date.now()
  return {
    ...boot,
    persist,
    startedAt,
    readyPromise,
    wakeReady,
    bootStep: 'the plane decision',
    ready: false,
    roster: null,
    handover: null,
    daemonLock: null,
    controlServer: null,
    releaseHeldReading: () => {},
    stopPlaneHeal: null,
    stopArmedBeat: null,
    stopLockBeat: null,
    stopSessionlessBeat: null,
    stopSaturnTicker: null,
    stopHostJobs: null,
    restartArmed: false,
    restartAfterTeardown: false,
    planeServedByOther: null,
    birthsInFlight: 0,
    sessionless,
    currentOwnerPid,
    ownerWatch: undefined,
    ownerPipe: undefined,
    orphanParking: false,
    askedToLeave: null,
    shuttingDown: false,
    teardownComplete: false,
  }
}

type BootStep = 'the seat ceiling' | 'the roster' | 'the control key' | 'the start token' | 'the handover take' | 'the runners left without a host' | 'the control server' | 'the daemon record' | 'the host job sweep' | 'the Saturn ticker'

export function atBootStep(state: DaemonRunState, name: BootStep): <T>(started: T) => T {
  state.bootStep = name
  return started => started
}

export function markDaemonReady(state: DaemonRunState): void {
  state.ready = true
  state.wakeReady()
}
