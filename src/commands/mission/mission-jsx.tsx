import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
import { renderToString } from '../../utils/staticRender.js'
import {
  type ActiveMission,
  MISSION_CONDITION_MAX_LENGTH,
  clearActiveMission,
  getActiveMission,
  isMissionClearKeyword,
  setActiveMission,
} from '../../utils/hooks/missionHook.js'

// ============================================================================
// commands/mission/mission-jsx.tsx — /mission for interactive sessions.
// ----------------------------------------------------------------------------
// Routes its argument the same four ways as the -p handler (report / clear /
// too-long / arm). What differs is the arming answer: onDone gets
// { shouldQuery: true, metaMessages: [directive] }, which shows the user a
// short confirmation, slips the directive to the model out of the UI's
// sight, and starts the next turn at once — no waiting for the user to type
// something before the mission takes hold. The report path prints a small
// panel rendered to a string.
// ============================================================================

/** Status panel for the active mission (no-arg /mission). */
function MissionStatusPanel({ mission }: { mission: ActiveMission }): React.ReactNode {
  const iterationsLabel =
    mission.iterations === 0
      ? 'not yet evaluated'
      : `${mission.iterations} ${plural(mission.iterations, 'turn')}`
  // The three honest states: met (the hook now allows stops), disarmed (cap
  // reached without completion), or still active with its latest check.
  // Without the met/gaveUp branches a MET mission would keep showing its
  // stale "not yet met" reason. Wording matches the non-interactive handler
  // so the TUI and -p report the same truth.
  const stateLine = mission.met
    ? '✓ Mission met — stops are allowed; a new /mission replaces it'
    : mission.gaveUp
      ? '⚠\uFE0E Mission DISARMED (block cap reached, not met — set it again to re-arm)'
      : `${iterationsLabel}${mission.lastReason ? ` · ${mission.lastReason}` : ''}`
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

  // --- empty arg: report the active mission (or usage) ----------------------
  if (arg === '') {
    const mission = getActiveMission()
    if (!mission) {
      // No live hook — the persisted card still answers (a peer process
      // reading this session's continuity record); same fallback as the
      // headless command. Settled states are history, reported as such.
      try {
        const { readMissionCard } = await import('../../services/mission/missionCard.js')
        const { getSessionId } = await import('../../bootstrap/state.js')
        const card = readMissionCard(getSessionId())
        if (card) {
          const stateLine =
            card.state === 'armed'
              ? 'Mission card ARMED (no live hook in this process — a resume re-arms it)'
              : `Mission card ${card.state}`
          onDone(`${stateLine}: ${card.goal}${card.nextStep ? `\nNext step: ${card.nextStep}` : ''}`)
          return null
        }
      } catch {
        // The card store answering nothing is the same as no card.
      }
      onDone('No mission set. Usage: `/mission <condition>`')
      return null
    }
    const output = await renderToString(<MissionStatusPanel mission={mission} />)
    onDone(output)
    return null
  }

  // --- the clear keywords ------------------------------------------------------
  if (isMissionClearKeyword(arg)) {
    const cleared = clearActiveMission(setAppState)
    onDone(cleared === null ? 'No mission set' : `Mission cleared: ${cleared}`, {
      display: 'system',
    })
    return null
  }

  // --- condition length --------------------------------------------------------
  if (arg.length > MISSION_CONDITION_MAX_LENGTH) {
    onDone(
      `Mission condition is limited to ${MISSION_CONDITION_MAX_LENGTH} characters (got ${arg.length})`,
      { display: 'system' },
    )
    return null
  }

  // --- arm the mission ---------------------------------------------------------
  // Hook installed and record written by setActiveMission; the returned
  // directive goes out as the hidden meta message described in the header.
  const directive = setActiveMission(setAppState, arg)
  onDone(`Mission set: ${arg}`, {
    shouldQuery: true,
    metaMessages: [directive],
  })
  return null
}
