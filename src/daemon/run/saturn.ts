import type { makeConcourseDispatchHandler } from '../concourseDispatch.js'
import { makeConcourseAdmitHandler, readSessionWorkers } from '../concourseWorkers.js'
import { isProcessAlive } from '../../utils/ownerWatch.js'
import { deriveScheduleAccountForModel, liveFactsForSessionFire } from '../saturnAccount.js'
import { makeSaturnBirthPort } from '../saturnBirth.js'
import { startSaturnTicker } from '../saturnTicker.js'
import { onSeatSpawned, pushScheduleRosterForSession } from '../sessionSeat.js'
import { refreshSignInReads } from '../signInView.js'
import { markHosted } from './owner.js'
import { atBootStep, type DaemonRunState } from './state.js'

interface SaturnNeeds {
  concourseDispatchHandler: ReturnType<typeof makeConcourseDispatchHandler>
  warmAdmitDoors: Pick<Parameters<typeof makeConcourseAdmitHandler>[0], 'claimWarm' | 'ensureWarm'>
}

export function armSaturn(state: DaemonRunState, { concourseDispatchHandler, warmAdmitDoors }: SaturnNeeds): void {
  state.stopSaturnTicker = atBootStep(state, 'the Saturn ticker')(startSaturnTicker(
    {
      now: () => Date.now(),
      records: () => {
        const superseded = state.planeServedByOther !== null && isProcessAlive(state.planeServedByOther.pid)
        return Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined && (superseded ? (state.roster?.has(r.runnerId).alive ?? false) : !(state.handover?.holds(r.runnerId) ?? false)))
      },
      liveFacts: (account, sessionId) => {
        refreshSignInReads()
        return liveFactsForSessionFire(account, sessionId)
      },
      deriveAccount: modelKey => {
        refreshSignInReads()
        return deriveScheduleAccountForModel(modelKey)
      },
      deliver: async d => {
        const result = await concourseDispatchHandler({
          clientMessageId: d.clientMessageId,
          prompt: d.prompt,
          workspaceDir: d.workspaceId,
          by: d.by,
          priority: 'later',
          ...(d.origin !== undefined ? { origin: d.origin } : {}),
          ...(d.parked ? { resumeSessionId: d.sessionId } : { targetSessionId: d.sessionId }),
        })
        return { ok: result.ok, ...(result.error !== undefined ? { detail: result.error } : {}) }
      },
      birth: makeSaturnBirthPort({
        dispatch: async req => {
          const r = await concourseDispatchHandler(req)
          return {
            ok: r.ok,
            ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
            ...(r.error !== undefined ? { error: r.error } : {}),
            ...(r.heldReason !== undefined ? { heldReason: r.heldReason } : {}),
          }
        },
        withdraw: id => concourseDispatchHandler.withdraw(id),
        admit: makeConcourseAdmitHandler({
          roster: () => state.roster ?? undefined,
          ...warmAdmitDoors,
          onSpawned: (runnerId, _spec, pid) => {
            console.error(`[daemon] schedule-born session admitted: ${runnerId} (pid ${pid})`)
            markHosted(state)
            if (state.roster !== null) onSeatSpawned(runnerId, state.roster)
          },
        }),
      }),
      screenOpen: () => (state.controlServer?.leaseCount() ?? 0) > 0,
      rosterChanged: sessionId => {
        if (state.roster !== null) pushScheduleRosterForSession(sessionId, state.roster)
      },
    },
    r => {
      console.error(`[daemon] saturn tick: ${r.fired} fired, ${r.replayed} replayed, ${r.held} held, ${r.missed} missed${r.dropped > 0 ? `, ${r.dropped} self-paced wake${r.dropped === 1 ? '' : 's'} dropped (stopped)` : ''}`)
    },
  ))
}
