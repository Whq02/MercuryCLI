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


export const call = async (
  rawArg: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const arg = rawArg.trim()
  const { setAppState } = context
  const text = (value: string): LocalCommandResult => ({ type: 'text', value })

  if (arg === '') {
    const mission = getActiveMission()
    if (!mission) {
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
      }
      return text('No mission set. Usage: `/mission <condition>`')
    }
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

  if (isMissionClearKeyword(arg)) {
    const cleared = clearActiveMission(setAppState)
    return text(cleared === null ? 'No mission set' : `Mission cleared: ${cleared}`)
  }

  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    return text(
      `Mission condition is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
    )
  }

  const directive = setActiveMission(setAppState, arg)
  return text(`Mission set: ${arg}\n\n${directive}`)
}
