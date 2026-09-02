import { getGlobalConfig } from '../../config/globalConfig.js'
import { logError } from '../../log.js'


export type TeammateMode = 'auto' | 'tmux' | 'in-process'

let cliOverride: TeammateMode | null = null
let sessionMode: TeammateMode | null = null

export function setCliTeammateModeOverride(mode: TeammateMode): void {
  cliOverride = mode
}

export function getCliTeammateModeOverride(): TeammateMode | null {
  return cliOverride
}

export function clearCliTeammateModeOverride(newMode: TeammateMode): void {
  cliOverride = null
  sessionMode = newMode
}

export function captureTeammateModeSnapshot(): void {
  sessionMode = cliOverride ?? getGlobalConfig().teammateMode ?? 'auto'
}

export function getTeammateModeFromSnapshot(): TeammateMode {
  if (sessionMode === null) {
    logError(new Error('teammate mode read before the session snapshot was captured'))
    captureTeammateModeSnapshot()
  }
  return sessionMode ?? 'auto'
}
