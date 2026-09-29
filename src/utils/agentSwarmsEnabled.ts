import { flagEnv } from '../substrate/flagRegistry.js'
import { readRetiredCliFlags } from '../migrations/retiredCrewSpellings.js'

export function isAgentSwarmsEnabled(): boolean {
  return flagEnv('MERCURY_CREWMATES') !== '0' || readRetiredCliFlags(process.argv).includes('--agent-crews')
}
