import type { LocalCommandCall } from '../../types/command.js'
import { armBootSettingsLayerDeepLink } from '../../components/BootSplashScreen.js'
import { enterBootSettings } from '../../context/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

/**
 * /bootmenu — the route-owner entry into the in-process
 * Boot Settings projection (handoff, ruling 12). A pure route
 * transition: no splash process, no relaunch, the session beneath keeps
 * running. Outside the fullscreen surface the route grammar has no
 * frame to claim — refuse honestly instead of degrading the screen.
 *
 * CB-09: the command NAMES the menu, so it deep-links — the
 * canonical Boot face mounts with the settings layer already open (the
 * one-shot below, consumed at mount); esc closes the layer to the helmet
 * face, esc again restores the invoking session exactly. The receipt text
 * states that chain truthfully.
 */
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
  // Arm AFTER the successful transition: the face mounts on the commit that
  // React flushes after this handler returns, so the one-shot is always
  // consumed by exactly this entry (a refused enter never leaves it armed).
  armBootSettingsLayerDeepLink()
  return {
    type: 'text',
    value: 'Boot Settings opened — esc closes to the Boot screen, esc again returns to this session exactly as you left it.',
  }
}
