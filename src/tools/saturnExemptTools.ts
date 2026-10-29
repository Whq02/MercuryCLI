
import { flagEnv } from '../substrate/flagRegistry.js'

export const SATURN_EXEMPT_TOOL = 'ScheduleWakeup'

export function isSaturnExemptEnabled(): boolean {
  return flagEnv('MERCURY_SATURN_EXEMPT_WAKEUP') !== '0'
}
