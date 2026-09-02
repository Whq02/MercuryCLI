import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { getIsInteractive } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'


function tmuxControlModeHeuristic(): boolean {
  if (!process.env.TMUX) return false
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

let controlModeCache: boolean | undefined
let controlModeLogged = false

export function isTmuxControlMode(): boolean {
  if (controlModeCache !== undefined) return controlModeCache
  controlModeCache = tmuxControlModeHeuristic()
  if (controlModeCache) return true
  if (!process.env.TMUX) return controlModeCache
  if (process.env.TERM_PROGRAM !== undefined) return controlModeCache
  try {
    const probe = spawnSync('tmux', ['display-message', '-p', '#{client_control_mode}'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 2000,
      env: { ...subprocessEnv() },
    })
    if (probe.error || probe.status !== 0) return controlModeCache
    controlModeCache = (probe.stdout ?? '').trim() === '1'
  } catch {
  }
  return controlModeCache
}


export function isFullscreenEnvEnabled(): boolean {
  const raw = flagEnv('MERCURY_FULLSCREEN')
  if (isEnvDefinedFalsy(raw)) return false
  if (isEnvTruthy(raw)) return true
  if (isTmuxControlMode()) {
    if (!controlModeLogged) {
      controlModeLogged = true
      logForDebugging('fullscreen: disabled — tmux control mode detected (set MERCURY_FULLSCREEN=1 to override)')
    }
    return false
  }
  return true
}

export function isFullscreenActive(): boolean {
  return getIsInteractive() && isFullscreenEnvEnabled()
}

export function isMouseTrackingEnabled(): boolean {
  return true
}

export function isMouseClicksDisabled(): boolean {
  return false
}

let tmuxMouseHintChecked = false

export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  if (!process.env.TMUX) return null
  if (!isFullscreenActive()) return null
  if (isTmuxControlMode()) return null
  if (tmuxMouseHintChecked) return null
  tmuxMouseHintChecked = true
  const result = await execFileNoThrow('tmux', ['show', '-Av', 'mouse'], { timeout: 2000, preserveOutputOnError: false })
  if (result.code !== 0) return null
  if (result.stdout.trim() === 'on') return null
  return 'tmux detected: PageUp/PageDown scroll the transcript. Add `set -g mouse on` to ~/.tmux.conf to restore wheel scrolling.'
}


export function isDeckPaneEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_DECK_PANE')) || isMercurySubstrateProfileOn()
}

export function isDeckPaneActive(): boolean {
  return isDeckPaneEnabled() && isFullscreenEnvEnabled()
}

export function isHelmHomeEnabled(): boolean {
  if (!isFullscreenEnvEnabled()) return false
  if (isEnvDefinedFalsy(flagEnv('MERCURY_HELM_HOME'))) return false
  return true
}
