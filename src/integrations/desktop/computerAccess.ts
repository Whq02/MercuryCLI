import { getSessionSovereign } from '../../boot/process-state/processState.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { resolveComputerAccess, type ComputerAccessResolution } from '../../platform/substrate/startupMenu.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'

export function savedComputerAccess(): string | undefined {
  return flagEnv('MERCURY_COMPUTER_ACCESS')
}

function sovereignPostureNow(): boolean {
  return getSessionSovereign() || isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS'))
}

function computerAccessNow(sovereignOn: boolean = sovereignPostureNow()): ComputerAccessResolution {
  return resolveComputerAccess(savedComputerAccess(), sovereignOn)
}

export function computerAccessPinnedToAsk(): boolean {
  const access = resolveComputerAccess(savedComputerAccess(), false)
  return access.source === 'saved' && access.value !== 'full'
}

export function computerAccessWords(access: ComputerAccessResolution = computerAccessNow()): string {
  if (access.source === 'sovereign mode') return 'access full (by sovereign mode)'
  if (access.source === 'saved' && access.value === 'full') return 'access full (saved)'
  return `access ${access.value}`
}
