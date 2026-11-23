import * as React from 'react'
import { useContext, useSyncExternalStore } from 'react'
import { buildRunCapsuleLine } from '../../commands/run/runInspectorModel.js'
import { formatSessionCost } from '../../models/roads/spendSpelling.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { getRunSnapshot, subscribeRuns } from '../../engine/run/runCoordinator.js'
import { countOperatorTurns } from '../../engine/message-shapes/operatorTurns.js'
import { advisorChipWords } from '../../models/advisor/advisorSettings.js'
import { Box, Text } from '../themedRenderer.js'
import { contextPercentLabel } from '../../engine/context-window/contextFill.js'
import { needsYouCount } from '../attention/needsYouCount.js'
import { useCatalogueEpoch } from '../model-picker/useCatalogueEpoch.js'
import { usePublish } from '../effects/effects.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../engine/connector/focusedConnector.js'
import { type ModelName, renderModelChip } from '../../models/catalogue/engineModel.js'
import { useDisplayedSessionModel, useFocusedContextFill } from '../model-picker/useDisplayedSessionModel.js'
import { publishContextUsage } from '../cockpit-gauges/contextUsageLive.js'
import { LAYOUT_BREAKPOINTS, useLayoutTier } from '../fullscreen-layout/useLayoutTier.js'
import { cachedAttentionView, subscribeAttentionView } from '../attention/viewModel.js'
import { bucketItems } from '../attention/contracts.js'
import { FLAG_ICON } from '../theme/rowGlyphs.js'
import { chatOnlyBoot } from '../routes/surfaceRoute.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { needsYouJump } from '../widgets/needsYouJump.js'
import { useIdleMotion } from '../effects/useIdleMotion.js'
import { governorTrip, motionPosture } from '../cockpit/motionGovernor.js'
import { registerObligationsAttentionGatherer } from '../../crew/crewmates/obligationsBridge.js'
import { registerWorkbenchAttentionGatherer } from '../workbench/attentionBridge.js'
import { isDeckPaneActive } from '../fullscreen-layout/fullscreen.js'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../fullscreen-layout/layoutChromeContext.js'
import { stringWidth } from '../renderer/stringWidth.js'
import { compactBandForm, shedToFit } from '../widgets/geometry.js'
import { compactModeChip } from '../widgets/compactModeChip.js'
import { useProviderUsageOnShow } from '../model-picker/useProviderUsageOnShow.js'
import { usagePollTtlMs } from '../../models/roads/usageFreshness.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../models/roads/anthropic/anthropicLimits.js'
import inkInstances from '../renderer/instances.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import {
  subscribeVerification,
  treeScanStatus,
  verificationSummary,
  verifyEvidenceEnabled,
} from '../../platform/verification/verificationState.js'
import {
  getModeColor,
  isDefaultMode,
  type PermissionMode,
  permissionModeSymbol,
  permissionModeTitle,
} from '../../permissions/rules/permissionMode.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { useFocusedTranscript } from '../focused-session/useFocusedTranscript.js'
import { useFocusedWorkspaceBranch } from '../focused-session/useFocusedWorkspaceBranch.js'
import { hasSeatLive } from '../../engine/connector/seatLive.js'
import { SessionMark } from '../widgets/assets.js'
import { Sep, useNowTick } from '../widgets/components.js'
import { EffortChip, RecordedEffortChip } from '../widgets/EffortChip.js'
import { useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { useCrewmateModel } from '../tasks/useCrewmateModel.js'
import { FailoverMark } from '../widgets/FailoverMark.js'
import { TrimChip } from '../widgets/TrimChip.js'
import { GLYPH, truncateToWidth, branchChip } from '../theme/glyphs.js'
import { ValueGlow } from '../widgets/LiveGlyphs.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { ctxChip, healthChipNode, usageChip } from './chips.js'

registerObligationsAttentionGatherer()
registerWorkbenchAttentionGatherer()

type Props = {
  model: ModelName
  routeSurface?: boolean
}

export const MercuryFrame = React.memo(MercuryFrameImpl)

const subscribeFocusedModelFacts = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSessionPin = (): string | null => getFocusedSessionConnector().modelFacts().sessionPin
const getFocusedAdvisorChip = (): string | null => advisorChipWords(getFocusedSessionConnector().advisorFacts())
const subscribeFocusedPermissionMode = subscribeThroughFocused((connector, listener) => connector.subscribePermissionMode(listener))
const getFocusedPermissionMode = (): PermissionMode | null => getFocusedSessionConnector().permissionMode()
const subscribeFocusedLive = subscribeThroughFocused((connector, listener) => (hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {}))
const getFocusedThinkingKey = (): string => {
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return ''
  const live = c.live()
  return live.inFlight && live.phase === 'thinking' ? 'thinking' : ''
}

function MercuryFrameImpl({ model, routeSurface = false }: Props): React.ReactNode {
  fluxMark('render:frame')
  const tok = useMercuryTokens()
  const messages = useFocusedTranscript()
  const { cwd, folder: dir, branch } = useFocusedWorkspaceBranch()

  const tier = useLayoutTier()
  const { isCompact, zen } = useLayoutChrome()
  const compactBudget = useContext(CompactFrameBudgetContext)
  const cols = tier.columns

  const sessionModelName = useDisplayedSessionModel().compact
  const viewedCrewmate = useViewedCrewmate()
  const crewmateModel = useCrewmateModel(routeSurface ? null : viewedCrewmate)
  const modelName = crewmateModel === null ? sessionModelName : crewmateModel.model === null ? 'model unreported' : renderModelChip(crewmateModel.model)
  const branchMax = tier.branchMax
  useSessionAccent()
  const helmActive = useContext(CockpitActiveContext) && !routeSurface
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const deckPresent = !routeSurface && isDeckPaneActive() && !helmActive
  const deckOwnsVitals = deckPresent && cols >= LAYOUT_BREAKPOINTS.cockpitMin
  const usageOwnedElsewhere = !routeSurface && (deckOwnsVitals || helmActive)

  const turns = countOperatorTurns(messages)
  const turnsNode =
    turns > 0 ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>{GLYPH.turns}</Text>
        {}
        <ValueGlow value={turns} color={tok.textSecondary}>{turns}</ValueGlow>
      </Text>
    ) : null

  const attentionView = useSyncExternalStore(
    subscribeAttentionView,
    cachedAttentionView,
    cachedAttentionView,
  )
  const boardChord = useShortcutDisplay('app:openSurfaceSwitcher', 'Global', 'ctrl+x c')
  const needsJump = needsYouJump({
    plain: chatOnlyBoot(),
    ownOnly: bucketItems(attentionView.attention, 'needs-you').every(item => item.owner === 'command-queue'),
    boardChord,
  })
  const needsNode =
    attentionView.needsYou > 0 ? (
      <Text>
        <Sep />
        <Text color={tok.warning}>{FLAG_ICON} {needsYouCount(attentionView.needsYou)}</Text>
        <Text color={tok.textMuted}> · {needsJump}</Text>
      </Text>
    ) : null

  const motionLevel = useIdleMotion('clock')
  const motionAuto = motionPosture() === 'auto'
  const motionNode =
    motionLevel === 'reduced' ? (
      <Text>
        <Sep />
        <Text color={motionAuto ? tok.warning : tok.textSecondary}>reduced</Text>
        {motionAuto && governorTrip() === 'wire' ? <Text color={tok.textMuted}> · slow link</Text> : null}
      </Text>
    ) : null

  let mouseOff = false
  try {
    const ink = inkInstances.get(process.stdout)
    mouseOff = !!ink && typeof ink.isMouseTrackingEnabled === 'function' && !ink.isMouseTrackingEnabled()
  } catch {
    mouseOff = false
  }
  const mouseNode = mouseOff ? (
    <Text>
      <Sep />
      <Text color={tok.warning}>mouse off — native copy sweeps rails</Text>
      <Text color={tok.textMuted}> · /mouse on = clean drag-copy</Text>
    </Text>
  ) : null

  const sessionPinnedModel = useSyncExternalStore(
    subscribeFocusedModelFacts,
    getFocusedSessionPin,
    getFocusedSessionPin,
  )
  const windowModel = routeSurface ? model : (sessionPinnedModel ?? model)
  useCatalogueEpoch()
  const fill = useFocusedContextFill(messages, windowModel, !routeSurface)
  const used = fill.usedPct
  const windowSize = fill.window
  usePublish(() => {
    publishContextUsage(used ?? null, windowSize, fill.compactAtPct, undefined, {
      usedTokens: fill.usedTokens,
      fillSource: fill.fillSource,
      windowSource: fill.windowSource,
      windowPinned: fill.windowPinned,
    })
  }, [used, windowSize, fill.compactAtPct, fill.usedTokens, fill.fillSource, fill.windowSource, fill.windowPinned])

  const ctxNode = ctxChip({ usageOwnedElsewhere, used, fill, tok })

  const advisorChip = useSyncExternalStore(subscribeFocusedModelFacts, getFocusedAdvisorChip, getFocusedAdvisorChip)
  const advisorNode = advisorChip !== null ? (
    <Text>
      <Sep />
      <Text color={tok.textSecondary}>{advisorChip}</Text>
    </Text>
  ) : null

  const usageFacts = getFocusedSessionConnector().usage()
  const cost = usageFacts.totalCostUSD
  const unpricedTurns = usageFacts.unpricedTurns ?? 0
  useProviderUsageOnShow(!isCompact && tier.showFrameQuota)
  const usageNow = useNowTick(!isCompact && tier.showFrameQuota ? Math.min(30_000, usagePollTtlMs()) : null)
  const costNode =
    (cost > 0 || unpricedTurns > 0) && getFocusedSessionConnector().identity().consoleBilling ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>{unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`}</Text>
      </Text>
    ) : null

  const usageNode = usageChip({ tier, usageNow, tok })

  const healthNode = healthChipNode({ helmActive, tok })

  const vfySnap = useSyncExternalStore(
    subscribeVerification,
    () => {
      if (!verifyEvidenceEnabled()) return null
      const s = verificationSummary(cwd, { skipDigest: true })
      if (s.state === 'stale' || s.state === 'failed') return s.state
      return treeScanStatus(cwd).state === 'unmeasured' ? 'unmeasured' : null
    },
    () => null,
  )
  const vfyNode =
    vfySnap !== null ? (
      <Text>
        <Sep />
        {vfySnap === 'failed' ? (
          <Text bold color={tok.failure}>
            vfy {GLYPH.fail} failed
          </Text>
        ) : (
          <Text color={tok.warning}>vfy {GLYPH.warn} {vfySnap}</Text>
        )}
      </Text>
    ) : null

  const runCapsule = useSyncExternalStore(
    subscribeRuns,
    () => buildRunCapsuleLine(getRunSnapshot(processMainOwner()), Date.now()),
    () => null,
  )
  const runNode = runCapsule ? (
    <Text>
      <Sep />
      <Text color={tok.textMuted}>{GLYPH.done} </Text>
      <Text color={tok.textSecondary}>{runCapsule}</Text>
    </Text>
  ) : null

  const permMode = useSyncExternalStore(
    subscribeFocusedPermissionMode,
    getFocusedPermissionMode,
    getFocusedPermissionMode,
  )
  const thinkingKey = useSyncExternalStore(subscribeFocusedLive, getFocusedThinkingKey, getFocusedThinkingKey)
  const focusedSeat = getFocusedSessionConnector()
  const thinkingStatus = thinkingKey === 'thinking' && hasSeatLive(focusedSeat) ? focusedSeat.status() : null
  const thinkingShown = !isCompact && !routeSurface && thinkingStatus !== null && thinkingStatus.wait === null
  useNowTick(thinkingShown ? 1000 : null)
  const modeBand = !isDefaultMode(permMode ?? undefined) ? (
    <Box width="100%" paddingX={1} flexShrink={0}>
      {permMode === 'sovereign' ? (
        <Text bold color={tok.failure} wrap="truncate-end">
          {permissionModeSymbol('sovereign')} {permissionModeTitle('sovereign').toLowerCase()} on — all tool calls auto-approved
        </Text>
      ) : (
        <Text color={getModeColor(permMode as PermissionMode)} wrap="truncate-end">
          {}
          {permissionModeSymbol(permMode as PermissionMode)}{' '}
          {permissionModeTitle(permMode as PermissionMode).toLowerCase()} on
          <Text color={tok.textMuted}> (shift+tab to cycle)</Text>
        </Text>
      )}
    </Box>
  ) : null

  const statusRow = (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <SessionMark />
        {!deckOwnsVitals ? (
          <Text>
            <Sep />
            <Text color={tok.textSecondary}>{modelName}</Text>
            {crewmateModel === null ? (
              <>
                <FailoverMark model={model} />
                <EffortChip model={model} />
              </>
            ) : <RecordedEffortChip effort={crewmateModel.effort} />}
          </Text>
        ) : null}
        <Sep />
        <Text color={tok.textPrimary}>{dir}</Text>
        {!deckOwnsVitals && branch ? (
          <Text color={tok.textMuted}> {branchChip(truncateToWidth(branch, branchMax))}</Text>
        ) : null}
        {turnsNode}
        {needsNode}
        {motionNode}
        {}
        {ctxNode}
        {!deckOwnsVitals ? costNode : null}
        {!usageOwnedElsewhere ? usageNode : null}
        {advisorNode}
        {}
        {healthNode}
        {vfyNode}
        {runNode}
        {}
        {!deckOwnsVitals ? <TrimChip /> : null}
        {mouseNode}
      </Text>
    </Box>
  )

  if (isCompact) {
    if ((compactBudget?.modelRows ?? 1) === 0) return null
    const chip = compactModeChip(permMode)
    const attentionCount = attentionView.needsYou > 0 ? needsYouCount(attentionView.needsYou) : ''
    const modelReturns = compactBandForm(cols, tier.rows) === 'none'
    const chosen = shedToFit([
      ...(chip !== null ? [{ id: 'mode', text: chip.text, priority: 4 }] : []),
      ...(zen && !routeSurface ? [{ id: 'zen', text: 'zen', priority: 0 }] : []),
      ...(attentionCount !== '' ? [{ id: 'attention', text: `${FLAG_ICON} ${attentionCount} · ${needsJump}`, priority: 3 }] : []),
      ...(modelReturns ? [
        { id: 'model', text: truncateToWidth(modelName || 'model unreported', cols), priority: 2 },
        { id: 'ctx', text: `ctx ${contextPercentLabel(used, fill.fillSource)}`, priority: 1 },
      ] : []),
    ], cols)
    if (chosen.length === 0) return null
    const line = chosen.map(part => part.text).join(' · ')
    const chipColor = chip === null ? tok.textSecondary : chip.tone === 'bypass' ? tok.failure : chip.modeColor
    return (
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">
          {chosen.map((part, index) => (
            <React.Fragment key={part.id}>
              {index > 0 ? <Text color={tok.textMuted}> · </Text> : null}
              {part.id === 'mode' ? (
                <Text color={chipColor}>{part.text}</Text>
              ) : part.id === 'attention' ? (
                <Text>
                  <Text color={tok.warning}>{FLAG_ICON} {attentionCount}</Text>
                  <Text color={tok.textMuted}> · {needsJump}</Text>
                </Text>
              ) : part.id === 'model' ? (
                <Text>
                  <Text color={tok.textSecondary}>{part.text}</Text>
                  {crewmateModel === null ? (
                    <>
                      <FailoverMark model={windowModel} />
                      <EffortChip model={windowModel} plain maxWidth={Math.max(0, cols - stringWidth(line))} />
                    </>
                  ) : <RecordedEffortChip effort={crewmateModel.effort} plain maxWidth={Math.max(0, cols - stringWidth(line))} />}
                </Text>
              ) : (
                <Text color={tok.textMuted}>{part.text}</Text>
              )}
            </React.Fragment>
          ))}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexShrink={0} width="100%" flexDirection="column">
      {modeBand}
      {helmActive ? null : statusRow}
    </Box>
  )
}
