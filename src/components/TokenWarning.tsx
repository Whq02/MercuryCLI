
import React from 'react'
import { Text } from '../ink.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js'
import { getUpgradeMessage } from '../utils/model/contextWindowUpgradeCheck.js'

export function TokenWarning({
  tokenUsage,
  model,
}: {
  tokenUsage: number
  model: string
}): React.ReactNode {
  const suppressed = useCompactWarningSuppression()
  const { level, pctLeft } = calculateTokenWarningState(tokenUsage, model)
  if (level === 'ok' || suppressed) return null

  const upgrade = getUpgradeMessage(model)
  const percent = pctLeft ?? 0

  if (isAutoCompactEnabled()) {
    return (
      <Text dimColor wrap="truncate">
        Context left until auto-compact: {percent}%
        {upgrade ? ` · ${upgrade.tip}` : ''}
      </Text>
    )
  }
  const envKill = isEnvTruthy(process.env.DISABLE_COMPACT)
    ? 'DISABLE_COMPACT'
    : isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)
      ? 'DISABLE_AUTO_COMPACT'
      : null
  return (
    <Text color="error" wrap="truncate">
      Context low ({percent}% remaining) · auto-compact is off
      {envKill ? ` (${envKill} set)` : ' — /config re-enables it'} · /compact summarizes now
      {upgrade ? ` · ${upgrade.tip}` : ''}
    </Text>
  )
}

export default TokenWarning
