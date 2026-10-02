import { flagEnv } from '../substrate/flagRegistry.js'

export function isAgentSwarmsEnabled(): boolean {
  return flagEnv('MERCURY_CREWMATES') !== '0'
}
