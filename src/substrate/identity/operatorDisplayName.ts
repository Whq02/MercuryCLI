import os from 'node:os'
import { flagEnv } from '../flagRegistry.js'

export function getOperatorName(): string {
  const env = flagEnv('MERCURY_OPERATOR')?.trim()
  if (env) return env
  try {
    return os.userInfo().username || 'operator'
  } catch {
    return 'operator'
  }
}
