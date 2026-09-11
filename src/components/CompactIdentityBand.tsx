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
import { GLYPH, branchChip } from './mercury-ui/glyphs.js'
import {
  CR_COLS,
  SQUARE_ART_LINES,
  SQUARE_DOCK_ART_LINES,
  critterDefForKey,
  squareDockArtFor,
} from '../utils/cockpit/critterData.js'
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
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'

const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))
const getFocusedTurnCount = (): number => countOperatorTurns(getFocusedSessionConnector().records())
const subscribeFocusedSeatLive = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
const getFocusedInFlight = (): boolean => {
  const connector = getFocusedSessionConnector()
  return hasSeatLive(connector) ? connector.live().inFlight : false
}
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective

export function treeStateWord(git: Snapshot<{ data: GitData }> | null): string | null {
  if (git === null || git.data.git === null) return null
  return git.data.git.isClean ? 'clean' : 'uncommitted'
}

export function CompactIdentityBand(): React.ReactNode {
  const tok = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const form = compactBandForm(columns, rows)
  const sa = useSessionAccent()
  const rawDef = critterDefForKey(sa.key)
  const def = React.useMemo(
    () => ({
      ...rawDef,
      hue: sa.accent,
      hueDeep: sa.accentDeep,
      ...(form === 'dock' ? { square: squareDockArtFor(sa.key) } : {}),
    }),
    [rawDef, sa.accent, sa.accentDeep, sa.key, form],
  )
  const modelName = useDisplayedSessionModel().compact
  const effectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel)
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const turns = useSyncExternalStore(subscribeFocusedRecords, getFocusedTurnCount, getFocusedTurnCount)
  const inFlight = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedInFlight, getFocusedInFlight)
  const cwd = useFocusedWorkspaceCwd()
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
  const treeState = treeStateWord(git)
  const used = ctx.usedPct
  const ctxColor = used !== null && used >= 90 ? tok.failure : used !== null && used >= 75 ? tok.warning : tok.textSecondary
  const modelFacts = (
    <Text>
      <Text color={tok.textSecondary}>{modelName || 'model unreported'}</Text>
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
          {inFlight ? null : <Text color={tok.textMuted}> · </Text>}
        </Text>
      </Box>
      {inFlight ? null : <Box flexShrink={0}><BreathingDot /></Box>}
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {inFlight ? null : <Text color={tok.success}> ready</Text>}
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
  const square = form === 'square'
  const artLines = square ? SQUARE_ART_LINES : SQUARE_DOCK_ART_LINES
  const artCols = square ? CR_COLS : def.square.reduce((max, row) => Math.max(max, row.length), 0)
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" height={artLines} flexShrink={0} overflow="hidden">
        <Box width={1} flexShrink={0} />
        <Box width={artCols} flexShrink={0} flexDirection="column" justifyContent="flex-end" onClick={cycleSessionCritter}>
          <AnimatedCritterArt def={def} square />
        </Box>
        <Box width={2} flexShrink={0} />
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {square ? <Box height={1} flexShrink={0} /> : null}
          {identityLine(square ? null : (
            <Text>
              <Text color={tok.textMuted}> · </Text>
              {modelFacts}
            </Text>
          ))}
          {square ? (
            <Box height={1} flexShrink={0} overflow="hidden">
              <Text wrap="truncate-end">{modelFacts}</Text>
            </Box>
          ) : null}
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate-end">
              {placeFacts}
              {square && treeState !== null ? <Text color={tok.textMuted}> · {treeState}</Text> : null}
              {!square && turnsFacts !== null ? (
                <Text>
                  <Text color={tok.textMuted}> · </Text>
                  {turnsFacts}
                </Text>
              ) : null}
            </Text>
          </Box>
          {square ? (
            <Box height={1} flexShrink={0} overflow="hidden">
              {turnsFacts !== null ? <Text wrap="truncate-end">{turnsFacts}</Text> : null}
            </Box>
          ) : null}
        </Box>
      </Box>
      {rule}
    </Box>
  )
}
