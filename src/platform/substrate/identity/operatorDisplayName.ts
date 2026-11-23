import os from 'node:os'
import { flagEnv } from '../flagRegistry.js'
import { passedOver } from '../../errors/passedOver.js'

export function getOperatorName(): string {
  const env = flagEnv('MERCURY_OPERATOR')?.trim()
  if (env) return env
  try {
    return os.userInfo().username || 'operator'
  } catch (error) {
    passedOver(error)
    return 'operator'
  }
}
