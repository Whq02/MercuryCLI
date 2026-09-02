import { flagEnabled, flagEnv, setFlagEnv } from '../../substrate/flagRegistry.js'

const RETIRED_SEAT_ENV_VARS: readonly string[] = [
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
]


export function scribeModeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_MODE')
}

export function implementerModeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_IMPLEMENTER')
}

export function scribeScopeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_SCOPE')
}

export function scribeBusEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BUS')
}

export function scribeBusLiveEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BUS_LIVE')
}

export function scribeBackPressureEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BACKPRESSURE')
}

export function scribeAutoClearEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_AUTOCLEAR')
}

export function scribeTaskRouterEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_TASK_ROUTER')
}

export function scribeChatroomEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_CHATROOM')
}


export function isScribeRole(): boolean {
  return flagEnv('MERCURY_SCRIBE') === '1'
}

export function isImplementerRole(): boolean {
  return flagEnv('MERCURY_IMPLEMENTER') === '1'
}


export function isCrewRole(): boolean {
  return flagEnv('MERCURY_CREW') === '1'
}

export function assertSingleRole(): void {
  const liveSet = ['MERCURY_SCRIBE', 'MERCURY_IMPLEMENTER', 'MERCURY_CREW'].filter(v => flagEnv(v) === '1')
  const retiredSet = RETIRED_SEAT_ENV_VARS.filter(v => process.env[v] === '1')
  const set = [...liveSet, ...retiredSet]
  if (set.length > 1) {
    throw new Error(
      `Amanuensis: a process must carry exactly ONE role env, but ${set.length} are set ` +
        `(${set.join(', ')}). Each spawned worker (Scribe/Implementer/Crew) is a single role.`,
    )
  }
}
