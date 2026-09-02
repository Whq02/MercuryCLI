
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { isEnvTruthy, isEnvDefinedFalsy } from '../envUtils.js'

export function supervisorEnabled(): boolean {
  const env = flagEnv('MERCURY_SUPERVISOR')
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false
  return getGlobalConfig().supervisorEnabled === true
}

export function setSupervisorEnabled(on: boolean): void {
  saveGlobalConfig(current => ({ ...current, supervisorEnabled: on }))
}
