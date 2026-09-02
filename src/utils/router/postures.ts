// ============================================================================
//  router/postures — the operator's routing posture (persisted + env-pinned).
//
//  Five postures (the /router command surface):
//    adaptive  semantic plan + bounded outcome history (the router-mode default)
//    quality   the planner-class bar drops one band (more Opus review/direct)
//    balanced  the plain policy table, no history contribution
//    fast      executor preferred for crisp nodes; synthesis never skipped
//    fixed     the pinned un-routed topology — nothing routes
//  Resolution precedence: MERCURY_ROUTER_POSTURE (env pin — how daemon children
//  inherit the operator's choice, and the hermetic proof seam) → the persisted
//  posture.json in the route-state dir → 'adaptive'. The model PIN
//  (opus|sonnet|auto) rides the same file: 'auto' routes; a class pin forces
//  every non-exact-pin node to that class (visible as source 'operator-pin').
//  Writes are atomic (temp → rename) and never throw at the caller.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { routerStateDir } from '../../substrate/routerPaths.js'
import type { RouterPosture } from './providers/types.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const ROUTER_POSTURES: readonly RouterPosture[] = [
  'adaptive',
  'quality',
  'balanced',
  'fast',
  'fixed',
]
export type RouterModelPin = 'opus' | 'sonnet' | 'auto'

export interface RouterPostureState {
  posture: RouterPosture
  pin: RouterModelPin
  updatedAt: number
}

const DEFAULT_STATE: RouterPostureState = { posture: 'adaptive', pin: 'auto', updatedAt: 0 }

export function routerPosturePath(): string {
  return join(routerStateDir(), 'posture.json')
}

export function isRouterPosture(v: unknown): v is RouterPosture {
  return typeof v === 'string' && (ROUTER_POSTURES as readonly string[]).includes(v)
}

/** The persisted posture file (total decode; damaged ⇒ defaults). */
export function readRouterPostureFile(): RouterPostureState {
  try {
    const raw = JSON.parse(readFileSync(routerPosturePath(), 'utf8')) as Record<string, unknown>
    return {
      posture: isRouterPosture(raw.posture) ? raw.posture : DEFAULT_STATE.posture,
      pin: raw.pin === 'opus' || raw.pin === 'sonnet' ? raw.pin : 'auto',
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    }
  } catch {
    return DEFAULT_STATE
  }
}

/** Persist a posture/pin patch (durable publication —; never
 *  throws: a write failure degrades to the previous persisted value, and the
 *  returned state is the IN-MEMORY next either way). */
export function writeRouterPosture(
  patch: Partial<Pick<RouterPostureState, 'posture' | 'pin'>>,
  now = Date.now(),
): RouterPostureState {
  const next: RouterPostureState = { ...readRouterPostureFile(), ...patch, updatedAt: now }
  try {
    durableAtomicPublishSync(routerPosturePath(), JSON.stringify(next, null, 2))
  } catch {
    // a posture write failure degrades to the previous persisted value
  }
  return next
}

/** The EFFECTIVE posture: env pin (validated) → persisted file → 'adaptive'. */
export function resolveRouterPosture(): RouterPosture {
  const env = flagEnv('MERCURY_ROUTER_POSTURE')?.trim().toLowerCase()
  if (isRouterPosture(env)) return env
  return readRouterPostureFile().posture
}

/** The effective model pin (env has no pin spelling — file only). */
export function resolveRouterModelPin(): RouterModelPin {
  return readRouterPostureFile().pin
}
