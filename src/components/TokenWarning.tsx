// The context-remaining / auto-compact warning line. Renders nothing at the
// ok level or while the post-compaction suppression is active. The
// warning-vs-error role split of the earlier tree resolved to error on both
// arms, so the non-auto-compact line is built as the one reachable arm
// the "reactive only" and "collapse" display modes were
// constant-false and are omitted by the same ruling.

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
  // Auto-compact is OFF here — the error says so and names the route home
  // (laws 1 + 3): the /config toggle when the config turned it off, or the
  // actual env kill when an environment variable forced it (that cause
  // /config cannot fix, so naming the toggle there would be a false route).
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
