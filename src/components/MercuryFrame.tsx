import { execFile } from 'child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { buildRunCapsuleLine } from '../commands/run/runInspectorModel.js'
import { formatSessionCost } from '../utils/spendSpelling.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { getRunSnapshot, subscribeRuns } from '../services/run/runCoordinator.js'
import { countOperatorTurns } from '../utils/messages/operatorTurns.js'
import { Box, Text } from '../ink.js'
import { contextFillView, contextPercentLabel } from '../utils/contextFill.js'
import { needsYouCount } from '../utils/needsYouCount.js'
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'
import { describeTurnOverride } from '../utils/autopilot/tierState.js'
import { getDisplayedEffortLabel, type EffortValue } from '../utils/effort.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { type ModelName, renderModelChip, renderModelName } from '../utils/model/model.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { publishContextUsage } from '../utils/cockpit/contextUsageLive.js'
import { LAYOUT_BREAKPOINTS, useLayoutTier } from '../hooks/useLayoutTier.js'
import { cachedAttentionView, subscribeAttentionView } from '../services/attention/viewModel.js'
import { bucketItems } from '../services/attention/contracts.js'
import { FLAG_ICON } from '../constants/figures.js'
import { chatOnlyBoot } from '../context/surfaceRoute.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { needsYouJump } from './mercury-ui/needsYouJump.js'
import { useSettledMotion } from '../hooks/useIdleMotion.js'
import { motionPosture } from '../utils/cockpit/motionGovernor.js'
import '../services/crew/obligationsBridge.js'
import '../services/workbench/attentionBridge.js'
import { isDeckPaneActive } from '../utils/fullscreen.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../context/layoutChromeContext.js'
import { stringWidth } from '../ink/stringWidth.js'
import { shedToFit } from './mercury-ui/geometry.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage, usageViewIsStale } from '../services/providers/providerUsage.js'
import { useProviderUsageOnShow } from '../hooks/useProviderUsageOnShow.js'
import { usageAgeTail, usagePollTtlMs } from '../services/providers/usageFreshness.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../services/claudeAiLimits.js'
import inkInstances from '../ink/instances.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import {
  subscribeVerification,
  treeScanStatus,
  verificationSummary,
  verifyEvidenceEnabled,
} from '../utils/verification/verificationState.js'
import {
  getModeColor,
  isDefaultMode,
  type PermissionMode,
  permissionModeSymbol,
  permissionModeTitle,
} from '../utils/permissions/PermissionMode.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { useFocusedTranscript } from '../hooks/useFocusedTranscript.js'
import { useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { formatQuietAge, workflowPulseAt } from '../tools/WorkflowTool/livePulse.js'
import { focusedWorkRows, runningWorkflowRows, useFocusedWorkRoster } from './tasks/useFocusedWork.js'
import type { AppState } from '../state/AppState.js'
import { SessionMark } from './mercury-ui/assets.js'
import { Sep, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { EffortChip } from './mercury-ui/EffortChip.js'
import { TrimChip } from './mercury-ui/TrimChip.js'
import { HarnessChip } from './mercury-ui/HarnessChip.js'
import { GLYPH, truncateToWidth, branchChip } from './mercury-ui/glyphs.js'
import { ValueGlow } from './mercury-ui/LiveGlyphs.js'
import { SessionTabs } from './mercury-ui/SessionTabs.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'


type Props = {
  model: ModelName
  routeSurface?: boolean
}

function readBranchSync(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

export const MercuryFrame = React.memo(MercuryFrameImpl)

const subscribeFocusedModelFacts = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSessionPin = (): string | null => getFocusedSessionConnector().modelFacts().sessionPin
const subscribeFocusedPermissionMode = subscribeThroughFocused((connector, listener) => connector.subscribePermissionMode(listener))
const getFocusedPermissionMode = (): PermissionMode | null => getFocusedSessionConnector().permissionMode()

function MercuryFrameImpl({ model, routeSurface = false }: Props): React.ReactNode {
  fluxMark('render:frame')
  const tok = useMercuryTokens()
  const messages = useFocusedTranscript()
  const cwd = useFocusedWorkspaceCwd()
  const [branch, setBranch] = useState<string | null>(() => readBranchSync(cwd))

  useEffect(() => {
    let alive = true
    setBranch(readBranchSync(cwd))
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { windowsHide: true, cwd, timeout: 500 },
      (err, stdout) => {
        if (!alive || err) return
        const b = stdout.trim()
        if (b && b !== 'HEAD') setBranch(b)
      },
    )
    return () => {
      alive = false
    }
  }, [cwd])

  const tier = useLayoutTier()
  const { isCompact } = useLayoutChrome()
  const compactBudget = useContext(CompactFrameBudgetContext)
  const cols = tier.columns

  const dir = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
  const modelName = useDisplayedSessionModel().compact
  const showBehavior = tier.showBehaviorChips
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

  const motionLevel = useSettledMotion('clock')
  const motionNode =
    motionLevel === 'reduced' ? (
      <Text>
        <Sep />
        <Text color={motionPosture() === 'auto' ? tok.warning : tok.textSecondary}>reduced</Text>
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
  const fill = contextFillView(messages, windowModel)
  const used = fill.usedPct
  const windowSize = fill.window
  useEffect(() => {
    publishContextUsage(used ?? null, windowSize, fill.compactAtPct, undefined, {
      usedTokens: fill.usedTokens,
      fillSource: fill.fillSource,
      windowSource: fill.windowSource,
    })
  }, [used, windowSize, fill.compactAtPct, fill.usedTokens, fill.fillSource, fill.windowSource])

  const ctxNode = !usageOwnedElsewhere ? (
    <Text>
      <Sep />
      <Text color={tok.textMuted}>ctx </Text>
      <Text
        color={
          used !== null && used >= 90
            ? tok.failure
            : used !== null && used >= 75
              ? tok.warning
              : tok.textSecondary
        }
      >
        {contextPercentLabel(used, fill.fillSource)}
      </Text>
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

  let usageNode: React.ReactNode = null
  if (tier.showFrameQuota) {
    const usage = activeSourceUsage({ model: getFocusedSessionConnector().modelFacts().main })
    const numberOnly = tier.numberOnlyGauges
    const showSecond = tier.show7dGauge
    const first = usage.windows[0]
    const second =
      usage.binding !== undefined && first !== undefined && usage.binding.window.key !== first.key
        ? usage.binding.window
        : usage.windows[1]
    const limited = usage.limited
    const ageTail = first !== undefined ? usageAgeTail(first, usageNow) : undefined
    usageNode =
      first !== undefined || limited !== undefined ? (
        <Text>
          <Sep />
          {first !== undefined ? (
            <UsageMeter
              compact
              numberOnly={numberOnly}
              window={first.label}
              state={first.state}
              value={first.usedPct ?? undefined}
            />
          ) : null}
          {second !== undefined && showSecond ? (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <UsageMeter
                compact
                window={second.label}
                state={second.state}
                value={second.usedPct ?? undefined}
              />
            </Text>
          ) : null}
          {ageTail !== undefined && first !== undefined ? (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <Text color={usageViewIsStale(first, usageNow) ? tok.warning : tok.textMuted}>{ageTail}</Text>
            </Text>
          ) : null}
          {limited !== undefined ? (
            <Text>
              {first !== undefined ? <Text color={tok.textMuted}> {GLYPH.dot} </Text> : null}
              <Text color={tok.warning}>limit · resets {formatCountdown(limited.resetsAtMs - Date.now())}</Text>
            </Text>
          ) : null}
        </Text>
      ) : null
  }

  const healthSnap = !helmActive ? healthCertSnapshot() : null
  const healthChip = healthSnap && healthSnap.state === 'live' ? healthSnap.data : null
  const healthAlarm =
    healthChip !== null &&
    (healthChip.verdict === 'fault' || healthChip.alert?.tone === 'fault')
  const healthWarn =
    healthChip !== null &&
    !healthAlarm &&
    (healthChip.verdict === 'caution' || healthChip.stale)
  const healthAge =
    healthChip?.ageLabel && healthChip.ageLabel !== 'never'
      ? healthChip.ageLabel.replace(' ago', '')
      : null
  const healthNode =
    healthChip && (healthAlarm || healthWarn) ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>health </Text>
        {healthAlarm ? (
          <Text bold color={tok.failure}>
            {GLYPH.fail} fault
          </Text>
        ) : (
          <Text color={tok.warning}>
            {GLYPH.warn} {healthChip.stale ? 'stale' : 'caution'}
          </Text>
        )}
        {healthAge ? <Text color={tok.textMuted}>{` · ${healthAge}`}</Text> : null}
      </Text>
    ) : null

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
  const autopilotEffort = useAppStateMaybeOutsideOfProvider(
    (s: { effortValue?: string | number } | undefined) => s?.effortValue,
  ) as EffortValue | undefined
  const allTasks = useAppStateMaybeOutsideOfProvider(
    (s: { tasks?: AppState['tasks'] } | undefined) => s?.tasks,
  ) as AppState['tasks'] | undefined
  const workRoster = useFocusedWorkRoster()
  const wfLive = React.useMemo(
    () => runningWorkflowRows(focusedWorkRows(allTasks, workRoster)),
    [allTasks, workRoster],
  )
  const wfNow = useNowTick(!isCompact && wfLive.length > 0 ? 10_000 : null)
  let wfNode: React.ReactNode = null
  if (wfLive.length > 0) {
    const pulses = wfLive.flatMap(w => (w.pulse ? [workflowPulseAt(w.pulse, wfNow)] : []))
    const worst = pulses.length > 0 ? pulses.reduce((a, b) => (a.quietMs >= b.quietMs ? a : b)) : null
    const label = wfLive.length === 1 ? 'wf' : `wf×${wfLive.length}`
    const phase =
      wfLive.length === 1 && worst?.phaseTitle
        ? ` ${truncateToWidth(worst.phaseTitle, 14)}`
        : ''
    wfNode = (
      <Text>
        <Sep />
        <Text color={worst === null || worst.moving ? tok.success : tok.warning}>
          {GLYPH.inProgress} {label}
          {phase}
          {worst !== null ? ` ${formatQuietAge(worst.quietMs)}` : ''}
        </Text>
      </Text>
    )
  }
  const autopilotTurnTier =
    permMode === 'autopilot' ? describeTurnOverride(undefined) : null
  const modeBand = !isDefaultMode(permMode ?? undefined) ? (
    <Box width="100%" paddingX={1} flexShrink={0}>
      {permMode === 'sovereign' ? (
        <Text bold color={tok.failure} wrap="truncate-end">
          {permissionModeSymbol('sovereign')} {permissionModeTitle('sovereign').toLowerCase()} on — all tool calls auto-approved
        </Text>
      ) : permMode === 'autopilot' ? (
        <Text bold color={tok.failure} wrap="truncate-end">
          {permissionModeSymbol('autopilot')} {permissionModeTitle('autopilot').toLowerCase()} on — permissions bypassed · self-tier armed
          <Text color={tok.textMuted}>
            {
}
            {
}
            {autopilotTurnTier ? ` · ⇅ ${autopilotTurnTier}` : ''}
          </Text>
        </Text>
      ) : (
        <Text color={getModeColor(permMode as PermissionMode)} wrap="truncate-end">
          {
}
          {permissionModeSymbol(permMode as PermissionMode)}{' '}
          {permissionModeTitle(permMode as PermissionMode).toLowerCase()} on
          <Text color={tok.textMuted}> (shift+tab to cycle)</Text>
        </Text>
      )}
    </Box>
  ) : null

  const statusRow = (
    <Box paddingX={helmActive ? 0 : 1}>
      <Text wrap="truncate-end">
        <SessionMark />
        {!deckOwnsVitals ? (
          <Text>
            <Sep />
            <Text color={tok.textSecondary}>{modelName}</Text>
            <EffortChip model={model} />
            <HarnessChip model={model} show={showBehavior} />
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
        {
}
        {wfNode}
        {ctxNode}
        {!deckOwnsVitals ? costNode : null}
        {!usageOwnedElsewhere ? usageNode : null}
        {
}
        {healthNode}
        {vfyNode}
        {runNode}
        {
}
        {!deckOwnsVitals ? <TrimChip /> : null}
        {mouseNode}
      </Text>
    </Box>
  )

  if (isCompact) {
    if ((compactBudget?.modelRows ?? 1) === 0) return null
    const modeText = permMode === 'sovereign'
      ? 'sovereign: auto-approved'
      : permMode === 'autopilot'
        ? 'autopilot: permissions bypassed'
        : permMode === null
          ? 'permissions unreported'
          : isDefaultMode(permMode) ? '' : permissionModeTitle(permMode).toLowerCase()
    const attentionText = attentionView.needsYou > 0 ? `${needsYouCount(attentionView.needsYou)} · ${needsJump}` : ''
    const chosen = shedToFit([
      ...(modeText ? [{ text: modeText, priority: 4 }] : []),
      ...(attentionText ? [{ text: attentionText, priority: 3 }] : []),
      { text: truncateToWidth(modelName || 'model unreported', cols), priority: 2 },
      { text: `ctx ${contextPercentLabel(used, fill.fillSource)}`, priority: 1 },
    ], cols)
    const line = chosen.map(part => part.text).join(' · ')
    const modelShown = chosen.some(part => part.priority === 2)
    const modelAt = chosen.findIndex(part => part.priority === 2)
    const prefix = modelAt >= 0 ? chosen.slice(0, modelAt + 1).map(part => part.text).join(' · ') : line
    const suffix = modelAt >= 0 ? chosen.slice(modelAt + 1).map(part => part.text).join(' · ') : ''
    return (
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={modeText !== '' || attentionText !== '' ? tok.warning : tok.textSecondary}>{prefix}</Text>
          {modelShown ? <EffortChip model={windowModel} plain maxWidth={Math.max(0, cols - stringWidth(line))} /> : null}
          {suffix !== '' ? <Text color={tok.textMuted}> · {suffix}</Text> : null}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexShrink={0} width="100%" flexDirection="column">
      {helmActive ? (
        <>
          {modeBand}
          <Box
            width="100%"
            flexDirection="column"
            borderStyle="round"
            borderColor={tok.borderStrong}
            paddingX={1}
          >
            {routeSurface ? null : <SessionTabs cols={cols} framed />}
            {statusRow}
          </Box>
        </>
      ) : (
        <>
          {
}
          {routeSurface ? null : <SessionTabs cols={cols} />}
          {modeBand}
          {statusRow}
        </>
      )}
    </Box>
  )
}
