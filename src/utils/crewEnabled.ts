import { flagEnv } from '../substrate/flagRegistry.js'

export function isCrewEnabled(): boolean {
  return flagEnv('MERCURY_CREWMATES') !== '0'
}
