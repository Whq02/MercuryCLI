import { getInitialSettings } from '../../utils/settings/settings.js'
import { passedOver } from '../../utils/passedOver.js'

export const SESSION_DEFAULTS_KEY_HINT = 'to select model-default'

export function sessionDefaultsKeyOn(): boolean {
  try {
    return getInitialSettings().engine?.sessionDefaults !== false
  } catch (error) {
    passedOver(error)
    return true
  }
}
