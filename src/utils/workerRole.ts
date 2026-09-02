import { flagEnv } from '../substrate/flagRegistry.js'

export const RETIRED_SEAT_ENV_VARS: readonly string[] = [
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
]

export const LIVE_ROLE_ENV_VARS: readonly string[] = ['MERCURY_CONCOURSE_WORKER']

export const ALL_ROLE_ENV_VARS: readonly string[] = [
  ...LIVE_ROLE_ENV_VARS,
  ...RETIRED_SEAT_ENV_VARS,
]

export function isCrewRole(): boolean {
  return flagEnv('MERCURY_CREW') === '1'
}

export function assertSingleRole(): void {
  const liveSet = ['MERCURY_CREW', ...LIVE_ROLE_ENV_VARS].filter(v => flagEnv(v) === '1')
  const retiredSet = RETIRED_SEAT_ENV_VARS.filter(v => process.env[v] === '1')
  const set = [...liveSet, ...retiredSet]
  if (set.length > 1) {
    throw new Error(
      `a process must carry exactly ONE role env, but ${set.length} are set ` +
        `(${set.join(', ')}). Each spawned worker is a single role.`,
    )
  }
}
