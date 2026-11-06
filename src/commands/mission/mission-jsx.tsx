import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
import { renderToString } from '../../utils/staticRender.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { MISSION_CONDITION_MAX_LENGTH, isMissionClearKeyword } from '../../guards/mission.js'
import type { MissionCardFactV1 } from '../../services/engine-connector/types.js'


type MissionView = Pick<MissionCardFactV1, 'goal' | 'state' | 'nextStep' | 'iterations'>

function MissionStatusPanel({ mission }: { mission: MissionView }): React.ReactNode {
  const iterationsLabel =
    mission.iterations === 0
      ? 'not yet checked'
      : `checked ${mission.iterations} ${plural(mission.iterations, 'time')}`
  const stateLine = mission.state === 'met'
    ? '✓ Mission met — stops are allowed; a new /mission replaces it'
    : mission.state === 'paused'
      ? `${GLYPH.warn} Mission paused — ${mission.nextStep ?? 'waiting on you'}; your next message resumes it`
      : `Mission active · ${iterationsLabel}${mission.nextStep ? ` · ${mission.nextStep}` : ''} · the session checks it at every turn end`
  return (
    <Box flexDirection="column">
      <Text bold>Standing mission</Text>
      <Box marginTop={1}>
        <Text dimColor>{stateLine}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{mission.goal}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>"/mission clear" to drop it</Text>
      </Box>
    </Box>
  )
}

async function sessionMissionCard(): Promise<MissionCardFactV1 | null> {
  const { getFocusedSessionConnector } = await import('../../services/engine-connector/focusedConnector.js')
  const connector = getFocusedSessionConnector()
  const fact = connector.workRoster().missionCard
  if (fact !== undefined && fact !== null) return fact
  try {
    const { readMissionCard } = await import('../../services/mission/missionCard.js')
    const card = readMissionCard(connector.sessionId(), connector.workspace().originalCwd)
    return card === null ? null : { goal: card.goal, state: card.state, nextStep: card.nextStep, iterations: card.iterations, setAt: card.setAt, updatedAt: card.updatedAt }
  } catch {
    return null
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const arg = args.trim()
  const { getFocusedSessionConnector, hasFocusedSession } = await import('../../services/engine-connector/focusedConnector.js')
  const hosted = hasFocusedSession()

  if (arg === '') {
    const card = hosted ? await sessionMissionCard() : null
    if (card === null) {
      onDone('No mission set. Usage: `/mission <goal>` (or `/goal <goal>`)')
      return null
    }
    if (card.state !== 'armed' && card.state !== 'paused' && card.state !== 'met') {
      onDone(`Mission card ${card.state}: ${card.goal}${card.nextStep ? `\nNext step: ${card.nextStep}` : ''}`)
      return null
    }
    const output = await renderToString(<MissionStatusPanel mission={card} />)
    onDone(output)
    return null
  }

  if (!hosted) {
    onDone('No session is open — start or open one, then /mission again', { display: 'system' })
    return null
  }

  if (isMissionClearKeyword(arg)) {
    const goal = (await sessionMissionCard())?.goal
    const receipt = await getFocusedSessionConnector().sendWords(`/mission ${arg}`, { metaFrom: { command: 'mission' } })
    onDone(receipt.state === 'accepted' ? `Mission cleared${goal === undefined ? '' : `: ${goal}`}` : `/mission ${arg} did not reach the session — ${receipt.detail}`, {
      display: 'system',
    })
    return null
  }

  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    onDone(
      `A goal is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
      { display: 'system' },
    )
    return null
  }

  const receipt = await getFocusedSessionConnector().sendWords(`/mission ${arg}`, { metaFrom: { command: 'mission' } })
  if (receipt.state !== 'accepted') {
    onDone(`/mission did not reach the session — ${receipt.detail}`, { display: 'system' })
    return null
  }
  onDone(`Mission set: ${arg}`)
  return null
}
