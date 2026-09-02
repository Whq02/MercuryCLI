// ============================================================================
// routeAliases — R1b:
//  the UI route-alias performer. A slash submission whose command carries
//  `uiRouteAlias` is an IMMEDIATE typed route action: the composer consumes
//  it before history, user-message persistence, Rewind indexing and provider
//  dispatch, then calls this performer. The route change itself is the
//  feedback on success; only a refusal answers with a TRANSIENT note (a
//  notification — never conversation material).
// ============================================================================

import type { UiRouteAliasKind } from '../types/command.js'
import { enterConcourse } from './surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'

export interface RouteAliasOutcome {
  /** True — the submission is consumed either way (routed or refused). */
  handled: true
  /** A transient refusal/status note for the notification rail; absent on a
   *  clean route (the surface swap is the receipt). */
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
