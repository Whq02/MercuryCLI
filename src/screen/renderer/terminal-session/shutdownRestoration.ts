import { writeSync } from 'node:fs'

import chalk from 'chalk'

import { getIsInteractive, getSessionId, isSessionPersistenceDisabled } from '../../../boot/process-state/processState.js'
import instances from '../instances.js'
import { noteModeSettledEverywhere, shutdownReleaseObligations } from '../root/terminalModeLedger.js'
import { isExtendedCsiSafe } from './capabilities.js'
import { resolveTerminalExperience } from './terminalExperience.js'
import { terminalTextCells } from './terminalTextCells.js'
import { BIDI_IMPLICIT, DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from '../termio/csi.js'
import { DBP, DFE, DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../termio/dec.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, CLEAR_TERMINAL_TITLE, supportsTabStatus, wrapForMultiplexer } from '../termio/osc.js'
import { binaryName } from '../../../platform/settings/config.js'
import { getCurrentSessionTitle, sessionIdExists } from '../../../sessions/transcripts/sessionStorage.js'
import { restoreOriginalBackground } from '../../cockpit/warmBackground.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { terminalTitleTransport } from '../../../platform/host-os/terminal.js'
import { quoteResumeTitleForShell } from '../../../platform/host-os/words.js'

function writeStdoutSync(bytes: string): boolean {
  if (!bytes || !process.stdout.isTTY) return false
  try {
    writeSync(1, bytes)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) return

  try {
    const initial = new Set(shutdownReleaseObligations())

    if (initial.has('mouse-tracking')) {
      writeStdoutSync(DISABLE_MOUSE_TRACKING)
      noteModeSettledEverywhere('mouse-tracking')
    }

    const active = instances.get(process.stdout)
    let altUnmounted = false
    if (active && !active.isUnmounted && active.isAltScreenActive) {
      try {
        active.unmount()
        altUnmounted = true
      } catch (error) {
        passedOver(error)
      }
    }

    if (!altUnmounted) {
      let altSequence = ''
      if (initial.has('alternate-scroll')) {
        altSequence += DISABLE_ALTERNATE_SCROLL
        noteModeSettledEverywhere('alternate-scroll')
      }
      if (initial.has('alt-screen')) {
        altSequence += EXIT_ALT_SCREEN
        noteModeSettledEverywhere('alt-screen')
      }
      writeStdoutSync(altSequence)
    }

    drainStdinForExit()

    const remainingInstance = instances.get(process.stdout)
    if (remainingInstance && !remainingInstance.isUnmounted) {
      try {
        remainingInstance.detachForShutdown()
      } catch (error) {
        passedOver(error)
      }
    }

    const owed = new Set(shutdownReleaseObligations())
    let sequence = ''

    if (owed.has('kitty-kbd')) {
      try {
        if (isExtendedCsiSafe()) {
          sequence += DISABLE_KITTY_KEYBOARD + DISABLE_MODIFY_OTHER_KEYS
        }
      } catch (error) {
        passedOver(error)
      }
      noteModeSettledEverywhere('kitty-kbd')
    }
    if (owed.has('focus-events')) {
      sequence += DFE
      noteModeSettledEverywhere('focus-events')
    }
    if (owed.has('bracketed-paste')) {
      sequence += DBP
      noteModeSettledEverywhere('bracketed-paste')
    }
    if (owed.has('mouse-tracking')) {
      sequence += DISABLE_MOUSE_TRACKING
      noteModeSettledEverywhere('mouse-tracking')
    }
    if (owed.has('cursor-hidden')) {
      sequence += SHOW_CURSOR
      noteModeSettledEverywhere('cursor-hidden')
    }
    if (terminalTextCells().explicitBidi) sequence += BIDI_IMPLICIT

    writeStdoutSync(sequence)

    try {
      restoreOriginalBackground()
    } catch (error) {
      passedOver(error)
    }
    if (owed.has('ground-osc')) {
      noteModeSettledEverywhere('ground-osc')
    }

    let tail = ''
    if (owed.has('progress-ring')) {
      tail += CLEAR_ITERM2_PROGRESS
      noteModeSettledEverywhere('progress-ring')
    }
    try {
      if (supportsTabStatus()) {
        tail += wrapForMultiplexer(CLEAR_TAB_STATUS)
      }
    } catch (error) {
      passedOver(error)
    }
    if (owed.has('terminal-title')) {
      try {
        if (resolveTerminalExperience().terminalTitle.effective) {
          if (terminalTitleTransport() === 'process-title') {
            process.title = ''
          } else {
            tail += CLEAR_TERMINAL_TITLE
          }
        }
      } catch (error) {
        passedOver(error)
      }
      noteModeSettledEverywhere('terminal-title')
    }

    writeStdoutSync(tail)
  } catch (error) {
    passedOver(error)
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
  try {
    const sessionId = getSessionId()
    if (!sessionId || !sessionIdExists(sessionId)) return
    const title = getCurrentSessionTitle(sessionId)
    const arg = resumeHintArgument(title, sessionId)
    const command = `${binaryName()} --resume ${arg}`
    if (writeStdoutSync(`\nResume this session with:\n${chalk.dim(command)}\n`)) {
      resumeHintPrinted = true
    }
  } catch (error) {
    passedOver(error)
  }
}

export function drainStdinForExit(): void {
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch (error) {
    passedOver(error)
  }
}
