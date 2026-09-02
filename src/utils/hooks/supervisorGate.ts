// ============================================================================
//  supervisorGate — the one switch for the run-completion supervisor (the
//  default Stop-evidence hook). OFF by default: an ordinary session ends its
//  turns unchallenged. /supervisor toggles it for this operator (persisted);
//  MERCURY_SUPERVISOR overrides per environment, read live so a toggle or an
//  env change takes effect at the very next stop — no restart.
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { isEnvTruthy, isEnvDefinedFalsy } from '../envUtils.js'

/** Live verdict: env pin wins in both directions; else the persisted toggle; else OFF. */
export function supervisorEnabled(): boolean {
  const env = flagEnv('MERCURY_SUPERVISOR')
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false
  return getGlobalConfig().supervisorEnabled === true
}

/** Persist the operator's toggle; the hook reads live, so this is immediate. */
export function setSupervisorEnabled(on: boolean): void {
  saveGlobalConfig(current => ({ ...current, supervisorEnabled: on }))
}
