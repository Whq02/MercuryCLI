// ============================================================================
//  routerGates — the route-fabric master gate.
//
//  Default-ON: every route decision is loud + carded, and nothing routes in
//  a plain session because nothing DISPATCHES in a plain session.
//  `MERCURY_ROUTER=0` yields the un-routed surface exactly: no /router, no
//  route-store writes, no route-kernel health probe.
// ============================================================================
import { flagEnabled } from '../../substrate/flagRegistry.js'

export function routerEnabled(): boolean {
  return flagEnabled('MERCURY_ROUTER')
}
