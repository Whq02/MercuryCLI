import { writeSync } from 'node:fs'

import chalk from 'chalk'

import { getIsInteractive, getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import instances from '../ink/instances.js'
import { noteModeSettledEverywhere, shutdownReleaseObligations } from '../ink/root/terminalModeLedger.js'
import { isExtendedCsiSafe } from '../ink/session/capabilities.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from '../ink/termio/csi.js'
import { DBP, DFE, DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../ink/termio/dec.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, CLEAR_TERMINAL_TITLE, supportsTabStatus, wrapForMultiplexer } from '../ink/termio/osc.js'
import { binaryName } from './config.js'
import { getCurrentSessionTitle, sessionIdExists } from './sessionStorage.js'
import { restoreOriginalBackground } from './cockpit/warmBackground.js'
import { passedOver } from './passedOver.js'
import { terminalTitleTransport } from './platform/terminal.js'
import { quoteResumeTitleForShell } from './platform/words.js'


function writeStdoutSync(bytes: string): void {
  if (!bytes || !process.stdout.isTTY) return
  try {
    writeSync(1, bytes)
  } catch (error) {
    passedOver(error)
  }
}

export function cleanupTerminalModes(): void {
  const obligations = new Set(shutdownReleaseObligations())
  let sequence = ''

  if (obligations.has('alt-screen')) {
    sequence += EXIT_ALT_SCREEN
    noteModeSettledEverywhere('alt-screen')
  }
  if (obligations.has('mouse-tracking')) {
    sequence += DISABLE_MOUSE_TRACKING
    noteModeSettledEverywhere('mouse-tracking')
  }
  if (obligations.has('alternate-scroll')) {
    sequence += DISABLE_ALTERNATE_SCROLL
    noteModeSettledEverywhere('alternate-scroll')
  }
  if (obligations.has('kitty-kbd')) {
    if (isExtendedCsiSafe()) {
      sequence += DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY_KEYBOARD
    }
    noteModeSettledEverywhere('kitty-kbd')
  }
  if (obligations.has('focus-events')) {
    sequence += DFE
    noteModeSettledEverywhere('focus-events')
  }
  if (obligations.has('bracketed-paste')) {
    sequence += DBP
    noteModeSettledEverywhere('bracketed-paste')
  }
  if (obligations.has('cursor-hidden')) {
    sequence += SHOW_CURSOR
    noteModeSettledEverywhere('cursor-hidden')
  }
  if (obligations.has('progress-ring')) {
    sequence += CLEAR_ITERM2_PROGRESS
    if (supportsTabStatus()) {
      sequence += wrapForMultiplexer(CLEAR_TAB_STATUS)
    }
    noteModeSettledEverywhere('progress-ring')
  }
  if (obligations.has('terminal-title')) {
    if (resolveTerminalExperience().terminalTitle.effective) {
      if (terminalTitleTransport() === 'process-title') {
        try {
          process.title = ''
        } catch (error) {
          passedOver(error)
        }
      } else {
        sequence += wrapForMultiplexer(CLEAR_TERMINAL_TITLE)
      }
    }
    noteModeSettledEverywhere('terminal-title')
  }

  writeStdoutSync(sequence)

  if (obligations.has('mouse-tracking') || obligations.has('alt-screen')) {
    drainStdinForExit()
  }

  if (process.stdin.isTTY && process.stdin.isRaw) {
    try {
      process.stdin.setRawMode(false)
    } catch (error) {
      passedOver(error)
    }
  }

  restoreOriginalBackground()
  if (obligations.has('ground-osc')) {
    noteModeSettledEverywhere('ground-osc')
  }
}


let resumeHintPrinted = false

export function resumeHintArgument(
  title: string | null | undefined,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!title) return sessionId
  return quoteResumeTitleForShell(title, platform)
}

export function printResumeHint(): void {
  if (resumeHintPrinted) return
  if (!getIsInteractive() || !process.stdout.isTTY || isSessionPersistenceDisabled()) return
  const sessionId = getSessionId()
  if (!sessionId || !sessionIdExists(sessionId)) return
  const title = getCurrentSessionTitle(sessionId)
  const arg = resumeHintArgument(title, sessionId)
  const command = `${binaryName()} --resume ${arg}`
  resumeHintPrinted = true
  writeStdoutSync(`\n${chalk.dim('Resume this session with:')}\n${command}\n`)
}


export function drainStdinForExit(): void {
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch (error) {
    passedOver(error)
  }
}
