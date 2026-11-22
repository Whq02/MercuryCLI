import type { UiRouteAliasKind } from '../types/command.js'
import { enterConcourse } from './surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { notBuilt } from '../pi/holes.js'

interface RouteAliasOutcome {
  handled: true
  note?: string
}

export function performUiRouteAlias(kind: UiRouteAliasKind): RouteAliasOutcome {
  return notBuilt('src/context/routeAliases.ts:11')
}
