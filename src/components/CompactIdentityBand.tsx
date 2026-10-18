import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { compactBandForm } from './mercury-ui/geometry.js'
import { AnimatedCritterArt, BreathingDot } from './mercury-ui/AnimatedCritterArt.js'
import { cycleSessionCritter, useSessionAccent } from './mercury-ui/sessionAccent.js'
import { Wordmark } from './mercury-ui/assets.js'
import { EffortChip } from './mercury-ui/EffortChip.js'
import { FailoverMark } from './mercury-ui/FailoverMark.js'
import { GLYPH, branchChip } from './mercury-ui/glyphs.js'
import { SQUARE_DOCK_ART_LINES, critterDefForKey } from '../utils/cockpit/critterData.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { pathTailLabel } from '../utils/pathLabel.js'
import { gitSnapshot, type GitData, type Snapshot } from '../utils/cockpit/index.js'
import { contextPercentLabel } from '../utils/contextFill.js'
import {
  getLiveContextUsage,
  getLiveContextUsageVersion,
  subscribeLiveContextUsage,
} from '../utils/cockpit/contextUsageLive.js'
import { countOperatorTurns } from '../utils/messages/operatorTurns.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'
import { CrewmateCard } from './CrewmateCard.js'
import { useViewedCrewmate } from './tasks/useCrewmateView.js'
import { crewStatusWords } from '../services/engine-connector/crewFacts.js'
import { COMPACT_BACK_HINT, crewmateCardKeys } from '../utils/cockpit/crewmateWords.js'

const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))
const getFocusedTurnCount = (): number => countOperatorTurns(getFocusedSessionConnector().records())
const subscribeFocusedSeatLive = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
const getFocusedInFlight = (): boolean => {
  const connector = getFocusedSessionConnector()
  return hasSeatLive(connector) ? connector.live().inFlight : false
}
const getFocusedLanding = (): boolean => landingInFlight() && !hasFocusedSession()
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective

export function compactBandIdle(inFlight: boolean, landing: boolean): boolean {
  return !inFlight && !landing
}

export function CompactIdentityBand(): React.ReactNode {
  const tok = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const form = compactBandForm(columns, rows)
  const sa = useSessionAccent()
  const rawDef = critterDefForKey(sa.key)
  const def = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep }),
    [rawDef, sa.accent, sa.accentDeep],
  )
  const modelName = useDisplayedSessionModel().compact
  const effectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel)
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const turns = useSyncExternalStore(subscribeFocusedRecords, getFocusedTurnCount, getFocusedTurnCount)
  const inFlight = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedInFlight, getFocusedInFlight)
  const landing = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedLanding, getFocusedLanding)
  const idle = compactBandIdle(inFlight, landing)
  const cwd = useFocusedWorkspaceCwd()
  const viewed = useViewedCrewmate()
  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  useEffect(() => {
    let alive = true
    setGit(null)
    gitSnapshot().then(snapshot => alive && setGit(snapshot))
    return () => {
      alive = false
    }
  }, [cwd])
  if (form === 'none') return null
  const dir = pathTailLabel(cwd)
  const branch = git?.data.git?.branchName ?? null
  const used = ctx.usedPct
  const ctxColor = used !== null && used >= 90 ? tok.failure : used !== null && used >= 75 ? tok.warning : tok.textSecondary
  const modelFacts = (
    <Text>
      <Text color={tok.textSecondary}>{modelName || 'model unreported'}</Text>
      <FailoverMark model={effectiveModel} />
      <EffortChip model={effectiveModel} plain />
      <Text color={tok.textMuted}> · ctx </Text>
      <Text color={ctxColor}>{contextPercentLabel(used, ctx.fillSource)}</Text>
    </Text>
  )
  const placeFacts = (
    <Text>
      <Text color={tok.textPrimary}>{dir}</Text>
      {branch !== null ? <Text color={tok.textMuted}> {branchChip(branch)}</Text> : null}
    </Text>
  )
  const turnsFacts = turns > 0 ? (
    <Text>
      <Text color={tok.textMuted}>{GLYPH.turns}</Text>
      <Text color={tok.textSecondary}>{turns}</Text>
    </Text>
  ) : null
  const identityLine = (tail: React.ReactNode) => (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      <Box flexShrink={0}>
        <Text>
          <Text color={sa.accent}>{GLYPH.spark} </Text>
          <Wordmark greeting={false} />
          {idle ? <Text color={tok.textMuted}> · </Text> : null}
        </Text>
      </Box>
      {idle ? <Box flexShrink={0}><BreathingDot /></Box> : null}
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {idle ? <Text color={tok.success}> ready</Text> : null}
          {tail}
        </Text>
      </Box>
    </Box>
  )
  const rule = <Text color={tok.borderStrong}>{'─'.repeat(Math.max(0, columns))}</Text>
  if (form === 'line') {
    if (viewed !== null) {
      const facts = viewed.facts
      const live = facts === null || facts.running
      return (
        <Box flexDirection="column" flexShrink={0}>
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color={viewed.pinned ? tok.warning : sa.accent} bold>{viewed.pinned ? GLYPH.star : GLYPH.circledBullet} {viewed.name}</Text>
              {facts !== null ? <Text color={live ? tok.success : tok.textSecondary}> · {crewStatusWords(facts, Date.now())}</Text> : null}
              <Text color={tok.textMuted}> · {crewmateCardKeys(viewed.pinned, live, COMPACT_BACK_HINT)}</Text>
            </Text>
          </Box>
          {rule}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" flexShrink={0}>
        {identityLine(
          <Text>
            <Text color={tok.textMuted}> · </Text>
            {modelFacts}
            <Text color={tok.textMuted}> · </Text>
            {placeFacts}
          </Text>,
        )}
        {rule}
      </Box>
    )
  }
  const artCols = def.squareDock.reduce((max, row) => Math.max(max, row.length), 0)
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" height={SQUARE_DOCK_ART_LINES} flexShrink={0} overflow="hidden">
        <Box width={1} flexShrink={0} />
        <Box width={artCols} flexShrink={0} flexDirection="column" justifyContent="flex-end" onClick={cycleSessionCritter}>
          <AnimatedCritterArt def={def} square />
        </Box>
        <Box width={2} flexShrink={0} />
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {viewed !== null ? (
            <CrewmateCard crewmate={viewed} width={Math.max(12, columns - artCols - 3)} />
          ) : (
            <>
              {identityLine(
                <Text>
                  <Text color={tok.textMuted}> · </Text>
                  {modelFacts}
                </Text>,
              )}
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">
                  {placeFacts}
                  {turnsFacts !== null ? (
                    <Text>
                      <Text color={tok.textMuted}> · </Text>
                      {turnsFacts}
                    </Text>
                  ) : null}
                </Text>
              </Box>
            </>
          )}
        </Box>
      </Box>
      {rule}
    </Box>
  )
}
