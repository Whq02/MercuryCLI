import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { approvedChannelFor } from '../../extensions/load/channels.js'


export function isChannelsEnabled(): boolean {
  const flag = flagEnv('MERCURY_CHANNELS')
  if (isEnvDefinedFalsy(flag)) return false
  if (isEnvTruthy(flag)) return true
  return true
}

function isChannelApproved(serverName: string | undefined): boolean {
  if (serverName === undefined || serverName === '') return false
  return approvedChannelFor(serverName) !== null
}
