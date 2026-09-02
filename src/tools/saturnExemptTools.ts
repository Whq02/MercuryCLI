
import { flagEnv } from '../substrate/flagRegistry.js'

export const SATURN_EXEMPT_TOOL_A = 'PushNotification'

export const SATURN_EXEMPT_TOOL_B = 'ScheduleWakeup'

export function isSaturnExemptAEnabled(): boolean {
  return flagEnv('MERCURY_SATURN_EXEMPT_PUSH') !== '0'
}

export function isSaturnExemptBEnabled(): boolean {
  return flagEnv('MERCURY_SATURN_EXEMPT_WAKEUP') !== '0'
}
