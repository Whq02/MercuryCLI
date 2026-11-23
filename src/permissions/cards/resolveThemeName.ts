import { getGlobalConfig } from '../../platform/settings/config.js'
import { getSystemThemeName } from '../../screen/theme/systemTheme.js'

export function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}
