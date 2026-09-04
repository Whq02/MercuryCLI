import { writeSync } from 'node:fs'

import chalk from 'chalk'

import { getIsInteractive, getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import instances from '../ink/instances.js'
import { noteModeSettledEverywhere, shutdownReleaseObligations } from '../ink/root/terminalModeLedger.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from '../ink/termio/csi.js'
import { DBP, DFE, DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../ink/termio/dec.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, CLEAR_TERMINAL_TITLE, supportsTabStatus, wrapForMultiplexer } from '../ink/termio/osc.js'
import { binaryName } from './config.js'
import { getCurrentSessionTitle, sessionIdExists } from './sessionStorage.js'
import { restoreOriginalBackground } from './cockpit/warmBackground.js'


export function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) return
  try {
    const inst = instances.get(process.stdout)
    let open = new Set(shutdownReleaseObligations())

    if (open.has('mouse-tracking')) {
      writeSync(1, DISABLE_MOUSE_TRACKING)
      noteModeSettledEverywhere('mouse-tracking')
    }

    if (inst?.isAltScreenActive) {
      try {
        inst.unmount()
      } catch {
        open = new Set(shutdownReleaseObligations())
        if (open.has('alternate-scroll')) writeSync(1, DISABLE_ALTERNATE_SCROLL)
        writeSync(1, EXIT_ALT_SCREEN)
        noteModeSettledEverywhere('alternate-scroll')
        noteModeSettledEverywhere('alt-screen')
      }
    }

    inst?.drainStdin()
    inst?.detachForShutdown()

    open = new Set(shutdownReleaseObligations())
    if (open.has('kitty-kbd')) {
      writeSync(1, DISABLE_KITTY_KEYBOARD)
      writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
      noteModeSettledEverywhere('kitty-kbd')
    }
    if (open.has('focus-events')) {
      writeSync(1, DFE)
      noteModeSettledEverywhere('focus-events')
    }
    if (open.has('bracketed-paste')) {
      writeSync(1, DBP)
      noteModeSettledEverywhere('bracketed-paste')
    }
    if (open.has('mouse-tracking')) {
      writeSync(1, DISABLE_MOUSE_TRACKING)
      noteModeSettledEverywhere('mouse-tracking')
    }
    if (open.has('cursor-hidden')) {
      writeSync(1, SHOW_CURSOR)
      noteModeSettledEverywhere('cursor-hidden')
    }

    restoreOriginalBackground()
    if (open.has('progress-ring')) {
      writeSync(1, CLEAR_ITERM2_PROGRESS)
      noteModeSettledEverywhere('progress-ring')
    }
    if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
    if (open.has('terminal-title') && resolveTerminalExperience().terminalTitle.effective) {
      if (process.platform === 'win32') process.title = ''
      else writeSync(1, CLEAR_TERMINAL_TITLE)
      noteModeSettledEverywhere('terminal-title')
    }
  } catch {
  }
}


let resumeHintPrinted = false

export function resumeHintArgument(
  title: string | null | undefined,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!title) return sessionId
  return platform === 'win32'
    ? `'${title.replace(/'/g, "''")}'`
    : `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function printResumeHint(): void {
  if (resumeHintPrinted) return
  if (!process.stdout.isTTY) return
  if (!getIsInteractive()) return
  if (isSessionPersistenceDisabled()) return
  const sessionId = getSessionId()
  if (!sessionIdExists(sessionId)) return
  const title = getCurrentSessionTitle(sessionId)
  const argument = resumeHintArgument(title, sessionId)
  try {
    writeSync(1, `\nResume this session with:\n${chalk.dim(`${binaryName()} --resume ${argument}`)}\n`)
    resumeHintPrinted = true
  } catch {
  }
}


export function drainStdinForExit(): void {
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {
  }
}
