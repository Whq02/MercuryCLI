import type { LocalCommandResult } from '../../types/command.js'
import {
  pingsBellEnabled,
  setPingsBellEnabled,
} from '../../services/pings/pingsGate.js'


export const call = async (rawArg: string): Promise<LocalCommandResult> => {
  const arg = rawArg.trim().toLowerCase()
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    return {
      type: 'text',
      value: `pings is ${pingsBellEnabled() ? 'on' : 'off'} — /pings toggles the bell, /pings on|off sets it (the rows stay either way)`,
    }
  }
  const next = arg === '' ? !pingsBellEnabled() : arg === 'on'
  setPingsBellEnabled(next)
  return {
    type: 'text',
    value: next
      ? 'pings on — the bell rings once when a session needs you or finishes a run'
      : 'pings off — the bell stays quiet; the rows and the badge still say what needs you',
  }
}
