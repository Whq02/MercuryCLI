import type { LocalCommandCall } from '../../types/command.js'
import { enterConcourse } from '../../context/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

export const call: LocalCommandCall = async () => {
  if (!isFullscreenEnvEnabled()) {
    return {
      type: 'text',
      value:
        'The Session Concourse needs the fullscreen surface (MERCURY_FULLSCREEN=0 boots). Boot with the Concourse policy set, or from a fullscreen session run /concourse.',
    }
  }
  const res = enterConcourse()
  if (!res.ok) {
    return {
      type: 'text',
      value:
        res.code === 'already-current'
          ? 'The Session Concourse is already open.'
          : `The Session Concourse is unavailable — ${res.reason}`,
    }
  }
  return {
    type: 'text',
    value: 'Session Concourse opened — esc returns to the root REPL.',
  }
}
