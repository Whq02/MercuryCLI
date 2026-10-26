import { getGlobalConfig } from '../../utils/config.js'
import { getSystemThemeName } from '../../utils/systemTheme.js'

export function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}
