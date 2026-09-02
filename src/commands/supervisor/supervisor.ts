import type { LocalCommandResult } from '../../types/command.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  setSupervisorEnabled,
  supervisorEnabled,
} from '../../utils/hooks/supervisorGate.js'

// ============================================================================
// commands/supervisor/supervisor.ts — `/supervisor [on|off]`.
//
// The run-completion supervisor: when ON, a stop during an active substantive
// run is evidence-checked (open deliverables, post-mutation gaps) and
// re-prompted at most once per attempt; when OFF — the default — every stop
// passes untouched. The toggle persists across sessions and the hook reads it
// live, so it takes effect at the very next stop. MERCURY_SUPERVISOR, when
// set, pins the verdict for the environment and the toggle only records the
// preference underneath it.
// ============================================================================

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
