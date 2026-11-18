import type { DaemonBreaker } from '../../utils/daemonBreaker.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { ControlServerHandle } from '../controlServer.js'
import type { OwnerPipeHandleV1, OwnerWatchHandleV1 } from '../ownerWatch.js'

export interface DaemonRunBootFacts {
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
  ready: boolean
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
  ownerWatch: OwnerWatchHandleV1 | undefined
  ownerPipe: OwnerPipeHandleV1 | undefined
  teardownComplete: boolean
}

export function makeDaemonRunState(boot: DaemonRunBootFacts): DaemonRunState {
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
    ready: false,
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
    ownerWatch: undefined,
    ownerPipe: undefined,
    teardownComplete: false,
  }
}

export function markDaemonReady(state: DaemonRunState): void {
  state.ready = true
  state.wakeReady()
}
