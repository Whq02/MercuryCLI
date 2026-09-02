

import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'

export function isImplementerSpawnEnabled(): boolean {
  return flagEnabled('MERCURY_AMANUENSIS')
}

export function isScribeEngageDaemon(): boolean {
  return (
    flagEnv('MERCURY_DAEMON_SCRIBE_ENGAGE') === '1' ||
    flagEnv('MERCURY_AMANUENSIS') === '1'
  )
}

export function isScribeWorkflowsDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_SCRIBE_WORKFLOWS') === '1'
}

export function isCrewDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_CREW') === '1'
}
