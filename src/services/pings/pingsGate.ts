// ============================================================================
//  services/pings/pingsGate — the one switch for the pings bell (the
//  "Quiet by choice" rule). ON by default: a session taps you when it
//  needs you. /pings toggles it for this operator (persisted); the engine
//  reads it LIVE at tap time, so the toggle acts on the very next event —
//  the rows, the badge and the board never change with it, and nothing
//  repaints a saved value.
// ============================================================================

import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/** Live verdict: the persisted toggle; absent = ON (the default). */
export function pingsBellEnabled(): boolean {
  return getGlobalConfig().pingsBell !== false
}

/** Persist the operator's toggle; the engine reads live, so this is
 *  immediate. */
export function setPingsBellEnabled(on: boolean): void {
  saveGlobalConfig(current => ({ ...current, pingsBell: on }))
}
