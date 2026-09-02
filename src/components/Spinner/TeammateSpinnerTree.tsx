// The teammate spinner tree: a leader row, one row per running
// teammate sorted by task owner, and a hide row in selection mode. Nothing
// renders when no teammates run. In selection mode the leader is index −1
// and the hide row is index === teammate count; the hide row owns the
// closing corner, so no teammate row is "last" there.

import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getViewedTeammateTask } from '../../state/selectors.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../../tasks/InProcessTeammateTask/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { formatNumber } from '../../utils/format.js'
import { TeammateSpinnerLine } from './TeammateSpinnerLine.js'

export function TeammateSpinnerTree({
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
  const foregrounded = getViewedTeammateTask(appState) as
    | InProcessTeammateTaskState
    | undefined

  const teammates = Object.values(tasks)
    .filter(isInProcessTeammateTask)
    .filter(task => task.status === 'running')
    .sort((a, b) =>
      (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
    )

  if (teammates.length === 0) return null

  const leaderSelected = isInSelectionMode && selectedIndex === -1
  const leaderForegrounded = foregrounded === undefined
  const showPreview = appState.showTeammateMessagePreview === true

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={3}>
        <Text bold={leaderSelected}>{leaderSelected ? `${figures.pointer} ` : '  '}</Text>
        <Text dimColor={!leaderSelected} bold={leaderSelected}>
          {leaderSelected ? '╦' : '┬'}{' '}
        </Text>
        <Text bold>{TEAM_LEAD_NAME}</Text>
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
      {teammates.map((teammate, index) => (
        <TeammateSpinnerLine
          key={teammate.id}
          teammate={teammate}
          isLast={!isInSelectionMode && index === teammates.length - 1}
          isSelected={isInSelectionMode && selectedIndex === index}
          isForegrounded={
            foregrounded !== undefined && foregrounded.id === teammate.id
          }
          allIdle={allIdle}
          showPreview={showPreview}
        />
      ))}
      {isInSelectionMode ? (
        <Box paddingLeft={3}>
          <Text bold={selectedIndex === teammates.length}>
            {selectedIndex === teammates.length ? `${figures.pointer} ` : '  '}
          </Text>
          <Text
            dimColor={selectedIndex !== teammates.length}
            bold={selectedIndex === teammates.length}
          >
            ╚ hide
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
