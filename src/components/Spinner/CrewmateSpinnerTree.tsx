
import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getViewedCrewmateTask } from '../../state/selectors.js'
import {
  isInProcessCrewmateTask,
  type InProcessCrewmateTaskState,
} from '../../tasks/InProcessCrewmateTask/types.js'
import { CREW_LEAD_NAME } from '../../utils/swarm/constants.js'
import { formatNumber } from '../../utils/format.js'
import { CrewmateSpinnerLine } from './CrewmateSpinnerLine.js'

export function CrewmateSpinnerTree({
  selectedIndex,
  isInSelectionMode = false,
  allIdle = false,
  leaderVerb,
  leaderTokenCount,
  leaderIdleText,
}: {
  selectedIndex?: number
  isInSelectionMode?: boolean
  allIdle?: boolean
  leaderVerb?: string
  leaderTokenCount?: number
  leaderIdleText?: string
}): React.ReactNode {
  const tasks = useAppState((state: AppState) => state.tasks)
  const appState = useAppState((state: AppState) => state)
  const foregrounded = getViewedCrewmateTask(appState) as
    | InProcessCrewmateTaskState
    | undefined

  const crewmates = Object.values(tasks)
    .filter(isInProcessCrewmateTask)
    .filter(task => task.status === 'running')
    .sort((a, b) =>
      (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
    )

  if (crewmates.length === 0) return null

  const leaderSelected = isInSelectionMode && selectedIndex === -1
  const leaderForegrounded = foregrounded === undefined
  const showPreview = appState.showCrewmateMessagePreview === true

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={3}>
        <Text bold={leaderSelected}>{leaderSelected ? `${figures.pointer} ` : '  '}</Text>
        <Text dimColor={!leaderSelected} bold={leaderSelected}>
          {leaderSelected ? '╦' : '┬'}{' '}
        </Text>
        <Text bold>{CREW_LEAD_NAME}</Text>
        {!leaderForegrounded ? (
          <Text dimColor>
            {'  '}
            {leaderVerb ?? leaderIdleText ?? ''}
          </Text>
        ) : null}
        {leaderTokenCount !== undefined && leaderTokenCount > 0 ? (
          <Text dimColor>
            {'  '}
            {formatNumber(leaderTokenCount)} tokens
          </Text>
        ) : null}
        {leaderSelected ? <Text dimColor>{'  '}↑↓ select</Text> : null}
        {leaderSelected && !leaderForegrounded ? (
          <Text dimColor>{'  '}↵ open</Text>
        ) : null}
      </Box>
      {crewmates.map((crewmate, index) => (
        <CrewmateSpinnerLine
          key={crewmate.id}
          crewmate={crewmate}
          isLast={!isInSelectionMode && index === crewmates.length - 1}
          isSelected={isInSelectionMode && selectedIndex === index}
          isForegrounded={
            foregrounded !== undefined && foregrounded.id === crewmate.id
          }
          allIdle={allIdle}
          showPreview={showPreview}
        />
      ))}
      {isInSelectionMode ? (
        <Box paddingLeft={3}>
          <Text bold={selectedIndex === crewmates.length}>
            {selectedIndex === crewmates.length ? `${figures.pointer} ` : '  '}
          </Text>
          <Text
            dimColor={selectedIndex !== crewmates.length}
            bold={selectedIndex === crewmates.length}
          >
            ╚ hide
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
