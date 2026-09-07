import { flagEnv } from '../substrate/flagRegistry.js'

export function isAgentSwarmsEnabled(): boolean {
  return flagEnv('MERCURY_TEAMMATES') !== '0' || process.argv.includes('--agent-teams')
}
