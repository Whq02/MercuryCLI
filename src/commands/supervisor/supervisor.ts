import type { LocalCommandResult } from '../../types/command.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  setSupervisorEnabled,
  supervisorEnabled,
} from '../../utils/hooks/supervisorGate.js'


export const call = async (
  rawArg: string,
): Promise<LocalCommandResult> => {
  const arg = rawArg.trim().toLowerCase()
  const envPin = flagEnv('MERCURY_SUPERVISOR')
  const pinned = isEnvTruthy(envPin) || isEnvDefinedFalsy(envPin)
  if (arg === 'on' || arg === 'off') {
    setSupervisorEnabled(arg === 'on')
    const live = supervisorEnabled()
    return {
      type: 'text',
      value: pinned
        ? `supervisor preference saved: ${arg} — but MERCURY_SUPERVISOR pins it ${live ? 'on' : 'off'} for this environment`
        : `supervisor ${live ? 'on — stops during active runs are evidence-checked' : 'off — stops pass untouched'}`,
    }
  }
  const live = supervisorEnabled()
  return {
    type: 'text',
    value: `supervisor is ${live ? 'on' : 'off'}${pinned ? ' (pinned by MERCURY_SUPERVISOR)' : ''} — /supervisor on|off to change`,
  }
}
