import type * as React from 'react'
import { Text } from '../../ink.js'
import type { useFocusedContextFill } from '../../hooks/useDisplayedSessionModel.js'
import type { useLayoutTier } from '../../hooks/useLayoutTier.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { activeSourceUsage, usageViewIsStale } from '../../services/providers/providerUsage.js'
import { usageAgeTail } from '../../services/providers/usageFreshness.js'
import { healthCertSnapshot } from '../../utils/cockpit/healthCertSnapshot.js'
import { formatCountdown } from '../../utils/cockpit/quota.js'
import { contextPercentLabel } from '../../utils/contextFill.js'
import { Sep, UsageMeter, type useNowTick } from '../mercury-ui/components.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import type { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

type Tokens = ReturnType<typeof useMercuryTokens>

export function ctxChip({
  usageOwnedElsewhere,
  used,
  fill,
  tok,
}: {
  usageOwnedElsewhere: boolean
  used: ReturnType<typeof useFocusedContextFill>['usedPct']
  fill: ReturnType<typeof useFocusedContextFill>
  tok: Tokens
}): React.ReactNode {
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
  return ctxNode
}

export function usageChip({
  tier,
  usageNow,
  tok,
}: {
  tier: ReturnType<typeof useLayoutTier>
  usageNow: ReturnType<typeof useNowTick>
  tok: Tokens
}): React.ReactNode {
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
  return usageNode
}

export function healthChipNode({
  helmActive,
  tok,
}: {
  helmActive: boolean
  tok: Tokens
}): React.ReactNode {
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
  return healthNode
}
