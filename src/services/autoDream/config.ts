import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export function isAutoDreamEnabled(): boolean {
  const settings = getInitialSettings()
  if (settings.autoDreamEnabled !== undefined) return settings.autoDreamEnabled
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{ enabled?: unknown }>(
    'mercury_onyx_plover',
    {},
  )
  return remote?.enabled === true
}
