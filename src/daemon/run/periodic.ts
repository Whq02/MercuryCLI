import { SESSIONLESS_EXIT_BEAT_MS } from '../control/sessionlessExit.js'
import { ARMED_RESTART_BEAT_MS } from './restart.js'
import type { DaemonRunState } from './state.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'

const PLANE_HEAL_FLOOR_MS = 30_000
const HANDOVER_LOCK_BEAT_MS = 2_000
const RECONCILE_TICK_MS = 60_000

type PeriodicStop = 'stopPlaneHeal' | 'stopArmedBeat' | 'stopSessionlessBeat' | 'stopLockBeat'

interface PeriodicRow {
  readonly name: string
  readonly everyMs: number
  readonly holdsTheProcess: boolean
  readonly stoppedBy: PeriodicStop | null
}

const PERIODIC = [
  { name: 'the plane heal floor', everyMs: PLANE_HEAL_FLOOR_MS, holdsTheProcess: false, stoppedBy: 'stopPlaneHeal' },
  { name: 'the armed-restart beat', everyMs: ARMED_RESTART_BEAT_MS, holdsTheProcess: false, stoppedBy: 'stopArmedBeat' },
  { name: 'the sessionless beat', everyMs: SESSIONLESS_EXIT_BEAT_MS, holdsTheProcess: false, stoppedBy: 'stopSessionlessBeat' },
  { name: 'the idle-predecessor sweep', everyMs: SESSIONLESS_EXIT_BEAT_MS, holdsTheProcess: false, stoppedBy: 'stopSessionlessBeat' },
  { name: 'the handover lock beat', everyMs: HANDOVER_LOCK_BEAT_MS, holdsTheProcess: false, stoppedBy: 'stopLockBeat' },
  { name: 'the reconcile tick', everyMs: RECONCILE_TICK_MS, holdsTheProcess: false, stoppedBy: null },
  { name: 'the keep-alive', everyMs: 1 << 30, holdsTheProcess: true, stoppedBy: null },
] as const satisfies readonly PeriodicRow[]

export function periodicArmer(state: DaemonRunState): (name: (typeof PERIODIC)[number]['name'], work: () => void, alsoStops?: () => void) => ReturnType<typeof setInterval> {
  let next = 0
  return (name, work, alsoStops) => {
    const at = PERIODIC.findIndex(row => row.name === name)
    if (at < next) throw new Error(`the daemon's periodic work is armed in the order of its list: "${name}" was asked after "${PERIODIC[next - 1]?.name ?? 'nothing'}"`)
    next = at + 1
    state.bootStep = name
    const row = PERIODIC[at]!
    const timer = startInterval(work, row.everyMs)
    if (!row.holdsTheProcess) timer.unref?.()
    const stoppedBy = row.stoppedBy
    if (stoppedBy !== null) {
      const before = state[stoppedBy]
      state[stoppedBy] = () => {
        stopInterval(timer)
        alsoStops?.()
        before?.()
      }
    }
    return timer
  }
}
