
import React from 'react'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { Text } from '../themedRenderer.js'
import {
  calculateTokenWarningState,
  isAutoFoldEnabled,
} from '../../engine/compaction/autoFold.js'
import { useFoldWarningSuppression } from './useFoldWarningSuppression.js'
import { getUpgradeMessage } from '../../models/facts/contextWindowUpgradeCheck.js'

export function TokenWarning({
  tokenUsage,
  model,
}: {
  tokenUsage: number
  model: string
}): React.ReactNode {
  const suppressed = useFoldWarningSuppression()
  const { level, pctLeft } = calculateTokenWarningState(tokenUsage, model)
  if (level === 'ok' || suppressed) return null

  const upgrade = getUpgradeMessage(model)
  const percent = pctLeft ?? 0

  if (isAutoFoldEnabled()) {
    return (
      <Text dimColor wrap="truncate">
        Context left until auto-compact: {percent}%
        {upgrade ? ` · ${upgrade.tip}` : ''}
      </Text>
    )
  }
  const envKill = !flagEnabled('MERCURY_COMPACT')
    ? 'MERCURY_COMPACT=0'
    : !flagEnabled('MERCURY_AUTO_COMPACT')
      ? 'MERCURY_AUTO_COMPACT=0'
      : null
  return (
    <Text color="error" wrap="truncate">
      Context low ({percent}% remaining) · auto-compact is off
      {envKill ? ` (${envKill} set)` : ' — /config re-enables it'} · /compact summarizes now
      {upgrade ? ` · ${upgrade.tip}` : ''}
    </Text>
  )
}
