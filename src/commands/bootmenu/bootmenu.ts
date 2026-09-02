import type { LocalCommandCall } from '../../types/command.js'
import { armBootSettingsLayerDeepLink } from '../../components/BootSplashScreen.js'
import { enterBootSettings } from '../../context/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

export const call: LocalCommandCall = async () => {
  if (!isFullscreenEnvEnabled()) {
    return {
      type: 'text',
      value:
        'Boot Settings needs the fullscreen surface (MERCURY_FULLSCREEN=0 boots). The standalone Boot Menu on the next launch carries the same rows.',
    }
  }
  const res = enterBootSettings()
  if (!res.ok) {
    return {
      type: 'text',
      value:
        res.code === 'already-current'
          ? 'Boot Settings is already open.'
          : `Boot Settings is unavailable — ${res.reason}`,
    }
  }
  armBootSettingsLayerDeepLink()
  return {
    type: 'text',
    value: 'Boot Settings opened — esc closes to the Boot screen, esc again returns to this session exactly as you left it.',
  }
}
