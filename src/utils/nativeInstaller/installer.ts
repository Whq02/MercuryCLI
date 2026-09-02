import { isEnvTruthy } from '../envUtils.js'

/**
 * The surviving install-check seam of the retired native installer. This
 * product runs from its built artifact through a launcher and never
 * installs itself, so the check ALWAYS resolves empty — its purpose is
 * that a stale install method recorded by a prior real installation can
 * never produce PATH/alias nags at startup. Strictly read-only.
 */

export type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

export async function checkInstall(_force?: boolean): Promise<SetupMessage[]> {
  // Still read and short-circuited for compatibility; both branches are
  // empty either way.
  if (isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) return []
  return []
}
