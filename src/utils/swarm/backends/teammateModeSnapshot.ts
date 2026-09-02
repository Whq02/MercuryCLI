import { getGlobalConfig } from '../../config/globalConfig.js'
import { logError } from '../../log.js'

/**
 * Session-start snapshot of the teammate execution mode. Captured once so
 * later config edits cannot change the mode mid-session.
 */

export type TeammateMode = 'auto' | 'tmux' | 'in-process'

let cliOverride: TeammateMode | null = null
let sessionMode: TeammateMode | null = null

/** From `--teammate-mode`; set before capture, wins over the config key. */
export function setCliTeammateModeOverride(mode: TeammateMode): void {
  cliOverride = mode
}

/** Public: the settings UI reads it to show that a CLI flag pins the mode. */
export function getCliTeammateModeOverride(): TeammateMode | null {
  return cliOverride
}

/**
 * Used when the user changes the setting in the settings UI: the new mode is
 * passed in rather than re-read, to avoid racing the config write; the
 * override is dropped and the argument installed directly.
 */
export function clearCliTeammateModeOverride(newMode: TeammateMode): void {
  cliOverride = null
  sessionMode = newMode
}

export function captureTeammateModeSnapshot(): void {
  sessionMode = cliOverride ?? getGlobalConfig().teammateMode ?? 'auto'
}

export function getTeammateModeFromSnapshot(): TeammateMode {
  if (sessionMode === null) {
    // Reading before capture is an initialisation bug; capture lazily and
    // continue.
    logError(new Error('teammate mode read before the session snapshot was captured'))
    captureTeammateModeSnapshot()
  }
  return sessionMode ?? 'auto'
}
