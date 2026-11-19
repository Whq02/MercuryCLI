import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { failWorkingDispatchesForRunner } from '../concourseDispatch.js'
import { settleConcourseWorker, completeRequestedPark, retireRequestedPark } from '../concourseWorkers.js'
import { holdWorkerAsk } from '../permissionAsks.js'
import { TaskRoster } from '../roster.js'
import { onSeatIdle, onSeatApplied, answerSeatScheduleEdit, onSeatRow, onSeatSpawned, publishSeatFacts, requestSessionFacts } from '../sessionSeat.js'
import type { DaemonRunState } from './state.js'

export function makeDaemonRoster(state: DaemonRunState): TaskRoster {
  const { dir, breaker, maxInflight: MAX_INFLIGHT } = state
  return new TaskRoster({
    dir,
    breaker,
    maxInflight: MAX_INFLIGHT,
    onAsk: (short, params) => holdWorkerAsk(short, params),
    onRow: (short, row) => {
      if (!short.startsWith('concourse-w') || state.roster === null) return
      onSeatRow(short, row, state.roster)
    },
    onApplied: (short, params) => {
      if (!short.startsWith('concourse-w') || state.roster === null) return
      onSeatApplied(short, params, state.roster)
    },
    onScheduleEdit: (short, params) => {
      if (!short.startsWith('concourse-w') || state.roster === null) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
      return answerSeatScheduleEdit(short, params, state.roster)
    },
    onChildRelaunched: short => {
      if (!short.startsWith('concourse-w') || state.roster === null) return
      onSeatSpawned(short, state.roster)
    },
    onChildReady: short => {
      if (!short.startsWith('concourse-w') || state.roster === null) return
      publishSeatFacts(short, undefined, state.roster)
      requestSessionFacts(short, state.roster, { immediate: true })
    },
    onChildCrashed: short => {
      if (!short.startsWith('concourse-w') || state.roster === null) return
      publishSeatFacts(short, undefined, state.roster)
    },
    onDegraded: (reason, short) => {
      console.error(`[daemon] ${GLYPH.warn} DAEMON DEGRADED — ${reason}`)
      if (short !== undefined && short.startsWith('concourse-w')) {
        try {
          settleConcourseWorker(short)
        } catch {
        }
        try {
          failWorkingDispatchesForRunner(short, reason)
        } catch (e) {
          console.error(`[daemon] ${short}: its working dispatches were not settled as failed, so their sends read in progress until the next daemon boot: ${errorMessage(e)}`)
        }
      }
    },
    onIdle: short => {
      if (short.startsWith('concourse-w') && state.roster !== null) {
        const parkedWords = `[daemon] ${short} finished its turn and parked (a park was requested while it worked)`
        if (completeRequestedPark(short, state.roster)) {
          console.error(parkedWords)
        } else {
          void retireRequestedPark(short, state.roster)
            .then(parked => {
              if (parked) console.error(parkedWords)
            })
            .catch(e => logForDebugging(`[daemon] ${short}: the requested park's retirement threw (ignored): ${e}`))
        }
        onSeatIdle(short, state.roster)
      }
    },
  })
}
