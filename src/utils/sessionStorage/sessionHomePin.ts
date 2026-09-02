import { deleteFlagEnv, flagEnv } from '../../substrate/flagRegistry.js'

export function consumeSessionHomePin(): string | null {
  const pin = flagEnv('MERCURY_SESSION_HOME')
  deleteFlagEnv('MERCURY_SESSION_HOME')
  if (pin === undefined || pin.trim() === '') return null
  return pin
}
