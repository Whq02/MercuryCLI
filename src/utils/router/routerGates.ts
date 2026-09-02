// ============================================================================
//  routerGates — the route-fabric master gate.
//
//  Default-ON: routing inside the two opt-in router MODES is loud + carded,
//  so the mode engagement is the consent; nothing routes in a plain session
//  because nothing DISPATCHES in a plain session. `MERCURY_ROUTER=0` yields
//  the un-routed surface exactly: no RouteWork seam, no /router, no
//  route-store writes, and the dispatch bridge falls back to the
//  MERCURY_SCRIBE_TASK_ROUTER effort-only path.
// ============================================================================
import { flagEnabled } from '../../substrate/flagRegistry.js'

export function routerEnabled(): boolean {
  return flagEnabled('MERCURY_ROUTER')
}
