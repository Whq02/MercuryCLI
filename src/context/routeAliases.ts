
import type { UiRouteAliasKind } from '../types/command.js'
import { enterConcourse } from './surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'

export interface RouteAliasOutcome {
  handled: true
  note?: string
}

export function performUiRouteAlias(kind: UiRouteAliasKind): RouteAliasOutcome {
  switch (kind) {
    case 'concourse': {
      if (!isFullscreenEnvEnabled()) {
        return {
          handled: true,
          note: 'The Session Concourse needs the fullscreen surface (MERCURY_FULLSCREEN=0 boots).',
        }
      }
      const res = enterConcourse()
      if (res.ok) return { handled: true }
      return {
        handled: true,
        note:
          res.code === 'already-current'
            ? 'The Session Concourse is already open.'
            : `The Session Concourse is unavailable — ${res.reason}`,
      }
    }
  }
}
