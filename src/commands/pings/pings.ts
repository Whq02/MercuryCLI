import type { LocalCommandResult } from '../../types/command.js'
import {
  pingsBellEnabled,
  setPingsBellEnabled,
} from '../../services/pings/pingsGate.js'

// ============================================================================
// commands/pings/pings.ts — `/pings [on|off]`.
//
// The pings bell: a session taps you the moment it needs
// you — one terminal-bell ring per new need or finished run. Bare /pings
// TOGGLES the bell (the toggle verb); an explicit on|off sets it. The
// rows never change with it: the strip badge and the boards keep saying
// what needs you either way. Saved for this operator; the engine reads it
// live, so the toggle acts on the very next event.
// ============================================================================

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
