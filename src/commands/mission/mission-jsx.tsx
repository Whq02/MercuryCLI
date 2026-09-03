import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
import { renderToString } from '../../utils/staticRender.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  type ActiveMission,
  MISSION_CONDITION_MAX_LENGTH,
  clearActiveMission,
  getActiveMission,
  isMissionClearKeyword,
  setActiveMission,
} from '../../utils/hooks/missionHook.js'


type MissionView = Pick<ActiveMission, 'condition' | 'iterations' | 'lastReason' | 'met' | 'gaveUp'> & { seat?: boolean }

function MissionStatusPanel({ mission }: { mission: MissionView }): React.ReactNode {
  const iterationsLabel =
    mission.iterations === 0
      ? 'not yet evaluated'
      : `${mission.iterations} ${plural(mission.iterations, 'turn')}`
  const stateLine = mission.met
    ? '✓ Mission met — stops are allowed; a new /mission replaces it'
    : mission.gaveUp
      ? `${GLYPH.warn} Mission DISARMED (block cap reached, not met — set it again to re-arm)`
      : `${iterationsLabel}${mission.lastReason ? ` · ${mission.lastReason}` : ''}${mission.seat ? " · the hook rides the session's seat" : ''}`
  return (
    <Box flexDirection="column">
      <Text bold>Standing mission</Text>
      <Box marginTop={1}>
        <Text>{mission.condition}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{stateLine}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>"/mission clear" to drop it</Text>
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const arg = args.trim()
  const { setAppState } = context

  if (arg === '') {
    const { conversationIdHere, hasFocusedSession } = await import('../../services/engine-connector/focusedConnector.js')
    const hosted = hasFocusedSession()
    const mission = hosted ? undefined : getActiveMission()
    if (!mission) {
      try {
        const { readMissionCard } = await import('../../services/mission/missionCard.js')
        const card = readMissionCard(conversationIdHere())
        if (card) {
          if (card.state === 'armed' && hosted) {
            const output = await renderToString(
              <MissionStatusPanel
                mission={{ condition: card.goal, iterations: card.iterations, ...(card.nextStep ? { lastReason: card.nextStep } : {}), seat: true }}
              />,
            )
            onDone(output)
            return null
          }
          const stateLine =
            card.state === 'armed'
              ? 'Mission card ARMED (no live hook in this process — a resume re-arms it)'
              : `Mission card ${card.state}`
          onDone(`${stateLine}: ${card.goal}${card.nextStep ? `\nNext step: ${card.nextStep}` : ''}`)
          return null
        }
      } catch {
      }
      onDone('No mission set. Usage: `/mission <condition>`')
      return null
    }
    const output = await renderToString(<MissionStatusPanel mission={mission} />)
    onDone(output)
    return null
  }

  if (isMissionClearKeyword(arg)) {
    const cleared = clearActiveMission(setAppState)
    onDone(cleared === null ? 'No mission set' : `Mission cleared: ${cleared}`, {
      display: 'system',
    })
    return null
  }

  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    onDone(
      `Mission condition is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
      { display: 'system' },
    )
    return null
  }

  const directive = setActiveMission(setAppState, arg)
  onDone(`Mission set: ${arg}`, {
    shouldQuery: true,
    metaMessages: [directive],
  })
  return null
}
