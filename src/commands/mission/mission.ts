import type { LocalCommandResult } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
import {
  MISSION_CONDITION_MAX_LENGTH,
  clearActiveMission,
  getActiveMission,
  isMissionClearKeyword,
  setActiveMission,
} from '../../utils/hooks/missionHook.js'

// ============================================================================
// commands/mission/mission.ts — /mission for -p/SDK sessions.
// ----------------------------------------------------------------------------
// Argument routing, in order of the checks below: no argument reports, a
// clear keyword disarms, an over-long condition is refused, and anything
// else arms a mission.
//
// One structural limit shapes the arming answer: a plain-text command result
// has no way to kick off another model turn (the interactive handler does
// that through its onDone options). The workaround is to append the whole
// directive to the confirmation text — the model reads it whenever the next
// turn happens.
// ============================================================================

export const call = async (
  rawArg: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const arg = rawArg.trim()
  const { setAppState } = context
  const text = (value: string): LocalCommandResult => ({ type: 'text', value })

  // Route 1 — no argument: report the active mission (or usage).
  if (arg === '') {
    const mission = getActiveMission()
    if (!mission) {
      // No live hook — the persisted card still answers (a resumed session
      // pre-restore, or a peer process reading this session's continuity
      // record). Settled states are history, reported as such.
      try {
        const { readMissionCard } = await import('../../services/mission/missionCard.js')
        const { getSessionId } = await import('../../bootstrap/state.js')
        const card = readMissionCard(getSessionId())
        if (card) {
          const stateLine =
            card.state === 'armed'
              ? 'Mission card ARMED (no live hook in this process — a resume re-arms it)'
              : `Mission card ${card.state}`
          return text(
            `${stateLine}: ${card.goal}${card.nextStep ? `\nNext step: ${card.nextStep}` : ''}`,
          )
        }
      } catch {
        // The card store answering nothing is the same as no card.
      }
      return text('No mission set. Usage: `/mission <condition>`')
    }
    // Honest states first: a met mission and a cap-disarmed one are NOT
    // "active" — the report says what actually happened.
    const stateLabel = mission.met
      ? 'Mission met'
      : mission.gaveUp
        ? 'Mission DISARMED (block cap reached, not met — set it again to re-arm)'
        : 'Mission active'
    const iterationsLabel =
      mission.iterations === 0
        ? 'not yet evaluated'
        : `${mission.iterations} ${plural(mission.iterations, 'turn')}`
    const reasonLine = mission.lastReason ? `\nLast check: ${mission.lastReason}` : ''
    return text(`${stateLabel}: ${mission.condition} (${iterationsLabel})${reasonLine}`)
  }

  // Route 2 — a clear keyword disarms.
  if (isMissionClearKeyword(arg)) {
    const cleared = clearActiveMission(setAppState)
    return text(cleared === null ? 'No mission set' : `Mission cleared: ${cleared}`)
  }

  // Route 3 — an over-long condition is refused; nothing is armed.
  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    return text(
      `Mission condition is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
    )
  }

  // Route 4 — arm. The directive rides inside the confirmation text: a
  // plain-text result cannot start another model turn (see the header), so
  // the model must find it in the transcript on whatever next turn happens.
  const directive = setActiveMission(setAppState, arg)
  return text(`Mission set: ${arg}\n\n${directive}`)
}
