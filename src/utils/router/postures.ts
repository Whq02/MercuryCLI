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

export function writeRouterPosture(
  patch: Partial<Pick<RouterPostureState, 'posture' | 'pin'>>,
  now = Date.now(),
): RouterPostureState {
  const next: RouterPostureState = { ...readRouterPostureFile(), ...patch, updatedAt: now }
  try {
    durableAtomicPublishSync(routerPosturePath(), JSON.stringify(next, null, 2))
  } catch {
  }
  return next
}

export function resolveRouterPosture(): RouterPosture {
  const env = flagEnv('MERCURY_ROUTER_POSTURE')?.trim().toLowerCase()
  if (isRouterPosture(env)) return env
  return readRouterPostureFile().posture
}

export function resolveRouterModelPin(): RouterModelPin {
  return readRouterPostureFile().pin
}
