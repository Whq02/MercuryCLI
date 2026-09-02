import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { getIsInteractive } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'

/**
 * Surface policy: is the alt-screen surface on, is the mouse on, is the
 * deck pane / cockpit home on.
 */

// ---------------------------------------------------------------------------
// tmux control-mode detection
// ---------------------------------------------------------------------------

/**
 * The environment heuristic (zero subprocesses): TMUX set, TERM_PROGRAM
 * exactly `iTerm.app`, and TERM not starting with `screen`/`tmux` (plain
 * tmux overwrites both variables).
 */
function tmuxControlModeHeuristic(): boolean {
  if (!process.env.TMUX) return false
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

let controlModeCache: boolean | undefined
let controlModeLogged = false

/**
 * Under tmux control mode (the emulator owns every pane) the alt-screen plus
 * mouse-tracking path cannot work: a double click corrupts the terminal and
 * wheel events never arrive. The authoritative probe is SYNCHRONOUS on
 * purpose — it gates whether the process enters the alt screen, and an
 * async probe lost the race against the first render over SSH (where the
 * terminal-program variable does not propagate). The cache is seeded with
 * the heuristic FIRST so early returns never leave it undetermined; the
 * probe runs only in the SSH case where TERM_PROGRAM is absent.
 */
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
    // Keep the heuristic result.
  }
  return controlModeCache
}

// ---------------------------------------------------------------------------
// Fullscreen policy
// ---------------------------------------------------------------------------

/**
 * The Mercury-canonical variable. Explicit false → inline; explicit truthy →
 * fullscreen (the escape hatch overriding auto-detection); anything else
 * behaves as unset: off under tmux control mode (with a one-time debug
 * line), otherwise DEFAULT TO FULLSCREEN.
 */
export function isFullscreenEnvEnabled(): boolean {
  // The registry resolves the canonical spelling (and its bounded legacy alias).
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

/** Interactive session AND the environment policy says yes; headless paths never enter fullscreen. */
export function isFullscreenActive(): boolean {
  return getIsInteractive() && isFullscreenEnvEnabled()
}

/** Always on: no env opt-out exists (the runtime mouse toggle remains the
 *  escape). */
export function isMouseTrackingEnabled(): boolean {
  return true
}

/** Always false: no env opt-out exists. */
export function isMouseClicksDisabled(): boolean {
  return false
}

let tmuxMouseHintChecked = false

/**
 * A one-time hint when tmux's mouse option is off. The once-per-session flag
 * is consumed BEFORE the query, so a failed query still spends it. The
 * effective value must be read INCLUDING inherited values (`-A`) — an option
 * set only in the global configuration reads back empty at session scope.
 * The product deliberately does not change tmux's setting: it is
 * session-scoped and would leak to sibling panes.
 */
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

// ---------------------------------------------------------------------------
// Deck pane and cockpit home
// ---------------------------------------------------------------------------

/** Enabled by its flag or the substrate profile, independent of fullscreen. */
export function isDeckPaneEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_DECK_PANE')) || isMercurySubstrateProfileOn()
}

/** Enabled AND the fullscreen policy says yes — kept in one place so the status bar's shed gate and the deck's render gate cannot diverge. */
export function isDeckPaneActive(): boolean {
  return isDeckPaneEnabled() && isFullscreenEnvEnabled()
}

/**
 * The three-pane cockpit home: requires the fullscreen policy, is ON by
 * default, and is opted out of only by an explicitly false flag value
 * (`=0`), which restores the deck-strip home.
 */
export function isHelmHomeEnabled(): boolean {
  if (!isFullscreenEnvEnabled()) return false
  // `=0` is the only opt-out (it restores the deck-strip home).
  if (isEnvDefinedFalsy(flagEnv('MERCURY_HELM_HOME'))) return false
  return true
}
