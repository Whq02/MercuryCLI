import * as React from 'react'
import { UNNAMED_SESSION_WORD } from '../services/concourse/sessionNaming.js'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { isSessionsBarOn, setSessionsBar } from '../utils/cockpit/sessionsBar.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'
import { getSessionId } from '../bootstrap/state.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { stringWidth } from '../ink/stringWidth.js'
import { seatDisplayTitle } from './SwitchboardTagBar.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useViewedCrewmate } from './tasks/useCrewmateView.js'
import { crewmateHeaderGlyph, crewmateHeaderTail, MAIN_CHAT_WORD, VIEWING_WORD } from '../utils/cockpit/crewmateWords.js'


const subscribeFocusedSeatTitle = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
function getFocusedSeatName(): string {
  const c = getFocusedSessionConnector()
  return hasSeatLive(c) ? seatDisplayTitle(c.status()) : ''
}

export const SESSION_LABEL = 'VIEW'
export const UNNAMED_SESSION = UNNAMED_SESSION_WORD

export function headerSessionName(name: string, budget: number): string {
  const word = name.trim() === '' ? UNNAMED_SESSION : name.trim()
  return truncateToWidth(word, Math.max(1, budget))
}

export function headerNameBudget(width: number, missionSet: boolean): number {
  const free = Math.max(1, width - 2 - (2 + SESSION_LABEL.length) - 1)
  return missionSet ? Math.max(12, Math.floor(free / 2)) : free
}

export function HelmCenterHeader({ width }: { width: number }): React.ReactNode {
  const t = useMercuryTokens()
  const { accent } = useSessionAccent()
  const crewmate = useViewedCrewmate()
  const seatName = useSyncExternalStore(subscribeFocusedSeatTitle, getFocusedSeatName, getFocusedSeatName)
  const promptBarName = useAppStateMaybeOutsideOfProvider(
    (s: { standaloneAgentContext?: { name: string } } | undefined) => s?.standaloneAgentContext?.name,
  ) as string | undefined
  const localName = seatName !== '' ? seatName : (getCurrentSessionTitle(getSessionId()) ?? promptBarName ?? '')
  const mission = getActiveMission()
  const crewTail = crewmate === null ? '' : ` ${crewmateHeaderTail(crewmate)}`
  const shownName = crewmate === null ? localName : (crewmate.facts?.description ?? crewmate.name)
  const name = headerSessionName(shownName, Math.max(1, headerNameBudget(width, mission !== null && mission !== undefined) - stringWidth(crewTail)))
  const missionBudget = Math.max(0, width - 2 - (2 + SESSION_LABEL.length) - 12 - 1 - stringWidth(name) - stringWidth(crewTail))
  return (
    <Box width={width} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1} minWidth={0}>
        <InteractiveRow
          id="helm:center:session"
          directActivate
          onActivate={() => setSessionsBar(!isSessionsBarOn())}
          height={1}
          flexShrink={0}
        >
          {
}
          {hover => (
            <Text>
              <Text color={crewmate !== null && crewmate.pinned ? t.warning : accent}>{crewmateHeaderGlyph(crewmate !== null && crewmate.pinned)} </Text>
              <Text color={hover ? t.info : t.textMuted}>{SESSION_LABEL}</Text>
              {crewmate !== null ? (
                <Text>
                  <Text color={t.textMuted}> · </Text>
                  <Text color={t.textPrimary} bold>{crewmate.name}</Text>
                  <Text color={crewmate.pinned ? t.warning : t.textMuted}> · {crewmate.pinned ? MAIN_CHAT_WORD : VIEWING_WORD}</Text>
                </Text>
              ) : null}
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
        {
}
        <Text color={accent} bold>
          {name}
        </Text>
      </Box>
    </Box>
  )
}
