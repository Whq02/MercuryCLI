import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import {
  liveClockEnabled,
  liveClockSnapshot,
  subscribeLiveClock,
  subscribeLiveClockDisabled,
} from '../utils/cockpit/liveClock.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'


export function HelmCenterHeader({ width }: { width: number }): React.ReactNode {
  const t = useMercuryTokens()
  const { accent } = useSessionAccent()
  const clock = useSyncExternalStore(
    liveClockEnabled() ? subscribeLiveClock : subscribeLiveClockDisabled,
    liveClockSnapshot,
    liveClockSnapshot,
  )
  const mission = getActiveMission()
  const missionBudget = Math.max(0, width - 24 - clock.length)
  return (
    <Box width={width} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1} minWidth={0}>
        {
}
        <InteractiveRow
          id="helm:center:session"
          directActivate
          onActivate={() => requestCommandDispatch('/sessions')}
          height={1}
          flexShrink={0}
        >
          {
}
          {hover => (
            <Text>
              <Text color={accent}>{GLYPH.spark} </Text>
              <Text color={hover ? t.info : t.textMuted}>SESSION</Text>
            </Text>
          )}
        </InteractiveRow>
        {mission && missionBudget > 12 ? (
          <InteractiveRow
            id="helm:center:mission"
            directActivate
            onActivate={() => requestCommandDispatch('/mission')}
            height={1}
            flexShrink={1}
          >
            {hover => (
              <Text wrap="truncate-end">
                <Text color={t.textMuted}>{'   '}</Text>
                {
}
                <Text color={hover ? 'infoShimmer' : t.info} bold>
                  MISSION:
                </Text>
                <Text color={t.textSecondary}> {truncateToWidth(mission.condition, missionBudget)}</Text>
              </Text>
            )}
          </InteractiveRow>
        ) : null}
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={t.textMuted}>{clock}</Text>
      </Box>
    </Box>
  )
}
