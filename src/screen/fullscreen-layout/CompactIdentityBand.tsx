import { exitCrewmateView } from '../../crew/crewmates/crewmateView.js'
import { useSetAppStateMaybe } from '../app-state/AppState.js'
import * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useLoad } from '../effects/effects.js'
import { useTerminalSize } from './useTerminalSize.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { compactBandForm } from '../widgets/geometry.js'
import { AnimatedCritterArt } from '../widgets/AnimatedCritterArt.js'
import { cycleSessionCritter, useSessionAccent } from '../widgets/sessionAccent.js'
import { Wordmark } from '../widgets/assets.js'
import { EffortChip, RecordedEffortChip } from '../widgets/EffortChip.js'
import { FailoverMark } from '../widgets/FailoverMark.js'
import { GLYPH, branchChip } from '../theme/glyphs.js'
import { SQUARE_DOCK_ART_LINES, critterDefForKey } from '../cockpit/critterData.js'
import { useDisplayedSessionModel } from '../model-picker/useDisplayedSessionModel.js'
import { useFocusedWorkspaceCwd } from '../focused-session/useFocusedWorkspaceCwd.js'
import { pathTailLabel } from './pathLabel.js'
import { gitSnapshot, type GitData, type Snapshot } from '../cockpit-gauges/index.js'
import { contextPercentLabel } from '../../engine/context-window/contextFill.js'
import {
  getLiveContextUsage,
  getLiveContextUsageVersion,
  subscribeLiveContextUsage,
} from '../cockpit-gauges/contextUsageLive.js'
import { countOperatorTurns } from '../../engine/message-shapes/operatorTurns.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../engine/connector/focusedConnector.js'
import { hasSeatLive } from '../../engine/connector/seatLive.js'
import { useCrewmateIdentity } from '../tasks/useCrewmateModel.js'

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
  const crew = useCrewmateIdentity()
  const setAppState = useSetAppStateMaybe()
  const idle = compactBandIdle(crew?.live ?? inFlight, landing)
  const cwd = useFocusedWorkspaceCwd()
  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  useLoad(signal => {
    setGit(null)
    gitSnapshot().then(snapshot => !signal.aborted && setGit(snapshot))
  }, [cwd])
  if (form === 'none') return null
  const dir = pathTailLabel(cwd)
  const branch = git?.data.git?.branchName ?? null
  const used = crew === null ? ctx.usedPct : crew.contextPercent
  const ctxColor = used !== null && used >= 90 ? tok.failure : used !== null && used >= 75 ? tok.warning : tok.textSecondary
  const modelFacts = (
    <Text>
      <Text color={tok.textSecondary}>{crew?.model ?? (modelName || 'model unreported')}</Text>
      {crew === null ? <><FailoverMark model={effectiveModel} /><EffortChip model={effectiveModel} plain /></> : (
        <><RecordedEffortChip effort={crew.effort} plain /><Text color={tok.textSecondary}>{crew.next}</Text></>
      )}
      <Text color={tok.textMuted}> · ctx </Text>
      <Text color={ctxColor}>{contextPercentLabel(used, crew === null ? ctx.fillSource : 'usage')}</Text>
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
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row" onClick={crew?.viewed && setAppState !== null ? () => exitCrewmateView(setAppState) : undefined}>
      <Box flexShrink={0}>
        <Text>
          <Text color={sa.accent}>{GLYPH.spark} </Text>
          <Wordmark />
          {idle ? <Text color={tok.textMuted}> · </Text> : null}
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {idle ? <Text color={tok.success}>ready</Text> : null}
          {crew === null ? null : <Text color={tok.textSecondary}> · {crew.address}</Text>}
          {tail}
        </Text>
      </Box>
    </Box>
  )
  const rule = <Text color={tok.borderStrong}>{'─'.repeat(Math.max(0, columns))}</Text>
  if (form === 'line') {
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
        </Box>
      </Box>
      {rule}
    </Box>
  )
}
