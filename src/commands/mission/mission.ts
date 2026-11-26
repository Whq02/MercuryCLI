import type { LocalCommandResult } from '../catalogue/command.js'
import type { LocalJSXCommandContext } from '../catalogue/command.js'
import { plural } from '../../platform/text/strings.js'
import {
  MISSION_CONDITION_MAX_LENGTH,
  clearActiveMission,
  getActiveMission,
  isMissionClearKeyword,
  missionCompletedLine,
  setActiveMission,
} from '../../permissions/guards/mission.js'
import { passedOver } from '../../platform/errors/passedOver.js'


export const call = async (
  rawArg: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const arg = rawArg.trim()
  const text = (value: string): LocalCommandResult => ({ type: 'text', value })

  if (arg === '') {
    const mission = getActiveMission()
    if (!mission) {
      try {
        const { inspectMissionCard, missionCardUnreadWords } = await import('../../sessions/mission-card/missionCard.js')
        const { getSessionId } = await import('../../boot/process-state/processState.js')
        const read = inspectMissionCard(getSessionId())
        if (read.state === 'unreadable') {
          passedOver(read.error)
          return text(missionCardUnreadWords(read.path, read.error))
        }
        if (read.state === 'ok') {
          const card = read.card
          if (card.state === 'met' && card.outcome !== undefined) return text(missionCompletedLine({ condition: card.goal, setAt: Date.parse(card.setAt) }, card.outcome))
          const stateLine =
            card.state === 'armed' || card.state === 'paused'
              ? `Goal card ${card.state.toUpperCase()} (no live hook in this process — a resume re-arms it)`
              : `Goal card ${card.state}`
          return text(
            `${stateLine}: ${card.goal}${card.nextStep ? `\nNext step: ${card.nextStep}` : ''}`,
          )
        }
      } catch (error) {
        passedOver(error)
      }
      return text('No goal set. Usage: `/goal <goal>`')
    }
    if (mission.met && mission.outcome !== undefined) return text(missionCompletedLine(mission, mission.outcome))
    const stateLabel = mission.met
      ? 'Goal completed'
      : mission.paused !== undefined
        ? 'Goal PAUSED (not met — the operator\'s next message resumes it)'
        : 'Goal active'
    const iterationsLabel =
      mission.iterations === 0
        ? 'not yet evaluated'
        : `${mission.iterations} ${plural(mission.iterations, 'turn')}`
    const reasonLine = mission.lastReason ? `\nLast check: ${mission.lastReason}` : ''
    return text(`${stateLabel}: ${mission.condition} (${iterationsLabel})${reasonLine}`)
  }

  if (isMissionClearKeyword(arg)) {
    const cleared = clearActiveMission()
    return text(cleared === null ? 'No goal set' : `Goal cleared: ${cleared}`)
  }

  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    return text(
      `A goal is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
    )
  }

  const directive = setActiveMission(arg)
  return text(`Goal set: ${arg}\n\n${directive}`)
}
