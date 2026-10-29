import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'


export function isChannelsEnabled(): boolean {
  const flag = flagEnv('MERCURY_CHANNELS')
  if (isEnvDefinedFalsy(flag)) return false
  return true
}
