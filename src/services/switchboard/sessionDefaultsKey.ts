import { getInitialSettings } from '../../utils/settings/settings.js'

export const SESSION_DEFAULTS_KEY_HINT = 'to select model-default'

export function sessionDefaultsKeyOn(): boolean {
  try {
    return getInitialSettings().sessionDefaultsKey !== false
  } catch {
    return true
  }
}
