import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export function isMemoryUpkeepEnabled(): boolean {
  const settings = getInitialSettings()
  if (settings.memoryUpkeepEnabled !== undefined) return settings.memoryUpkeepEnabled
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{ enabled?: unknown }>(
    'mercury_onyx_plover',
    {},
  )
  return remote?.enabled === true
}
