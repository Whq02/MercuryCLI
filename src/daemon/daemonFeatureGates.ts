

import { flagEnv } from '../substrate/flagRegistry.js'

export function isCrewDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_CREW') === '1'
}
