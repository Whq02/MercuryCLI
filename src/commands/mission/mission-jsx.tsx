import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../catalogue/command.js'
import { formatDuration } from '../../platform/text/format.js'
import { plural } from '../../platform/text/strings.js'
import { renderToString } from '../../screen/renderer/staticRender.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { MISSION_CONDITION_MAX_LENGTH, isMissionClearKeyword } from '../../permissions/guards/mission.js'
import type { MissionCardFactV1 } from '../../engine/connector/types.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'


type MissionView = Pick<MissionCardFactV1, 'goal' | 'state' | 'nextStep' | 'iterations' | 'setAt' | 'outcome'>

function metLine(mission: MissionView): string {
  const outcome = mission.outcome
  if (outcome === undefined) return '✓ Mission met — stops are allowed; a new /mission replaces it'
  const elapsed = formatDuration(Math.max(0, Date.parse(outcome.metAt) - Date.parse(mission.setAt)), { mostSignificantOnly: true })
  return `✓ Mission completed — ${outcome.reason} · ${outcome.turns} ${plural(outcome.turns, 'turn')} · ${elapsed} · a new /mission replaces it`
}

function MissionStatusPanel({ mission }: { mission: MissionView }): React.ReactNode {
  const iterationsLabel =
    mission.iterations === 0
      ? 'not yet checked'
      : `checked ${mission.iterations} ${plural(mission.iterations, 'time')}`
  const stateLine = mission.state === 'met'
    ? metLine(mission)
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

type SessionMissionCardRead =
  | { state: 'ok'; card: MissionCardFactV1 }
  | { state: 'absent' }
  | { state: 'unreadable'; words: string }

async function sessionMissionCard(): Promise<SessionMissionCardRead> {
  const { getFocusedSessionConnector } = await import('../../engine/connector/focusedConnector.js')
  const connector = getFocusedSessionConnector()
  const fact = connector.workRoster().missionCard
  if (fact !== undefined && fact !== null) return { state: 'ok', card: fact }
  try {
    const { inspectMissionCard, missionCardUnreadWords } = await import('../../sessions/mission-card/missionCard.js')
    const read = inspectMissionCard(connector.sessionId(), connector.workspace().originalCwd)
    if (read.state === 'unreadable') {
      passedOver(read.error)
      return { state: 'unreadable', words: missionCardUnreadWords(read.path, read.error) }
    }
    if (read.state === 'absent') return { state: 'absent' }
    const card = read.card
    return {
      state: 'ok',
      card: { goal: card.goal, state: card.state, nextStep: card.nextStep, iterations: card.iterations, setAt: card.setAt, updatedAt: card.updatedAt, ...(card.outcome !== undefined ? { outcome: card.outcome } : {}) },
    }
  } catch (error) {
    passedOver(error)
    return { state: 'absent' }
  }
}

const FACT_WAIT_MS = 4000
const OLDER_RUNNER_LINE = 'the session took the line, but its runner did not take the mission: that runner predates session-owned missions — /restart restarts this chat on the installed build, then set the mission again'

async function missionFactArrives(expected: (card: MissionCardFactV1 | null | undefined) => boolean): Promise<boolean> {
  const { getFocusedSessionConnector } = await import('../../engine/connector/focusedConnector.js')
  const connector = getFocusedSessionConnector()
  if (expected(connector.workRoster().missionCard)) return true
  return new Promise(resolve => {
    let settle: (ok: boolean) => void = () => {}
    const unsubscribe = connector.subscribeWork(() => {
      if (expected(connector.workRoster().missionCard)) settle(true)
    })
    const timer = startTimeout(() => settle(false), FACT_WAIT_MS)
    settle = ok => {
      stopTimeout(timer)
      unsubscribe()
      resolve(ok)
    }
    if (expected(connector.workRoster().missionCard)) settle(true)
  })
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const arg = args.trim()
  const { getFocusedSessionConnector, hasFocusedSession } = await import('../../engine/connector/focusedConnector.js')
  const hosted = hasFocusedSession()

  if (arg === '') {
    const read = hosted ? await sessionMissionCard() : { state: 'absent' as const }
    if (read.state === 'unreadable') {
      onDone(read.words)
      return null
    }
    if (read.state === 'absent') {
      onDone('No mission set. Usage: `/mission <goal>` (or `/goal <goal>`)')
      return null
    }
    const card = read.card
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
    const current = await sessionMissionCard()
    const goal = current.state === 'ok' ? current.card.goal : undefined
    const receipt = await getFocusedSessionConnector().sendWords(`/mission ${arg}`, { metaFrom: { command: 'mission' } })
    if (receipt.state !== 'accepted') {
      onDone(`/mission ${arg} did not reach the session — ${receipt.detail}`, { display: 'system' })
      return null
    }
    const cleared = await missionFactArrives(card => card === undefined || card === null || card.state === 'cleared' || card.goal !== goal)
    onDone(cleared ? `Mission cleared${goal === undefined ? '' : `: ${goal}`}` : `/mission ${arg}: ${OLDER_RUNNER_LINE}`, { display: 'system' })
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
  const armed = await missionFactArrives(card => card !== undefined && card !== null && card.goal === arg && (card.state === 'armed' || card.state === 'paused' || card.state === 'met'))
  if (!armed) {
    onDone(`/mission: ${OLDER_RUNNER_LINE}`, { display: 'system' })
    return null
  }
  onDone(`Mission set: ${arg}`)
  return null
}
