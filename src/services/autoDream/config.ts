import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Leaf predicate for whether background memory consolidation (auto-dream) is
 * enabled. Deliberately minimal imports so UI components can read the state
 * without dragging in the forked-agent, task-registry and message-builder
 * chain.
 */
export function isAutoDreamEnabled(): boolean {
  const settings = getInitialSettings()
  if (settings.autoDreamEnabled !== undefined) return settings.autoDreamEnabled
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{ enabled?: unknown }>(
    'mercury_onyx_plover',
    {},
  )
  return remote?.enabled === true
}
