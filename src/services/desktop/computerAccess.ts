import { getSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { resolveComputerAccess, type ComputerAccessResolution } from '../../substrate/startupMenu.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export function savedComputerAccess(): string | undefined {
  return flagEnv('MERCURY_COMPUTER_ACCESS')
}

export function sovereignPostureNow(): boolean {
  return getSessionBypassPermissionsMode() || isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS'))
}

export function computerAccessNow(sovereignOn: boolean = sovereignPostureNow()): ComputerAccessResolution {
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
