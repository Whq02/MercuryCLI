// The footer teams pill: nothing at zero teammates; the count
// comes from the team context's teammate map and EXCLUDES the lead's own
// entry (contract: the conventional lead name). Inverted while selected;
// the Enter affordance shows only when selected AND the caller hints.

import React from 'react'
import { Text } from '../../ink.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'

export function TeamStatus({
  teamsSelected,
  showHint,
}: {
  teamsSelected: boolean
  showHint: boolean
}): React.ReactNode {
  const tok = useMercuryTokens()
  const teamContext = useAppState((s: AppState) => s.teamContext)

  const count = Object.values(teamContext?.teammates ?? {}).filter(
    teammate => teammate.name !== TEAM_LEAD_NAME,
  ).length
  if (count === 0) return null

  const label = `${count} teammate${count === 1 ? '' : 's'}`
  return (
    <Text backgroundColor={tok.surface1} inverse={teamsSelected}>
      {' '}
      {label}
      {teamsSelected && showHint ? (
        <Text dimColor> · enter opens the team view</Text>
      ) : null}{' '}
    </Text>
  )
}
