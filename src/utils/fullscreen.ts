import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { getIsInteractive } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'

let controlModeCache: boolean | undefined
let controlModeLogged = false
let tmuxMouseHintChecked = false

function inTmuxControlMode(): boolean {
  if (controlModeCache !== undefined) return controlModeCache
  const { TMUX, TERM_PROGRAM, TERM = '' } = hostEnv()
  if (TMUX && TERM_PROGRAM === 'iTerm.app' && !TERM.startsWith('screen') && !TERM.startsWith('tmux')) return controlModeCache = true
  if (!TMUX || TERM_PROGRAM !== undefined) return controlModeCache = false
  try {
    const result = spawnSync('tmux', ['display-message', '-p', '#{client_control_mode}'], {
      windowsHide: true, encoding: 'utf8', timeout: 2000, env: { ...subprocessEnv() },
    })
    return controlModeCache = !result.error && result.status === 0 && result.stdout.trim() === '1'
  } catch (error) {
    passedOver(error)
    return controlModeCache = false
  }
}

export function isFullscreenEnvEnabled(): boolean {
  const flag = flagEnv('MERCURY_FULLSCREEN')
  if (isEnvDefinedFalsy(flag)) return false
  if (isEnvTruthy(flag) || !inTmuxControlMode()) return true
  if (!controlModeLogged) {
    controlModeLogged = true
    logForDebugging('fullscreen: disabled — tmux control mode detected (set MERCURY_FULLSCREEN=1 to override)')
  }
  return false
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

export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  if (!hostEnv().TMUX || !isFullscreenActive() || inTmuxControlMode() || tmuxMouseHintChecked) return null
  tmuxMouseHintChecked = true
  const { code, stdout } = await execFileNoThrow('tmux', ['show', '-Av', 'mouse'], { timeout: 2000, preserveOutputOnError: false })
  return code === 0 && stdout.trim() !== 'on' ? "tmux detected: PageUp/PageDown scroll the transcript. Add `set -g mouse on` to ~/.tmux.conf to restore wheel scrolling." : null
}

export function isDeckPaneEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_DECK_PANE')) || isMercurySubstrateProfileOn()
}

export function isDeckPaneActive(): boolean {
  return isDeckPaneEnabled() && isFullscreenEnvEnabled()
}

export function isHelmHomeEnabled(): boolean {
  return isFullscreenEnvEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_HELM_HOME'))
}
