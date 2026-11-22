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
import { notBuilt } from '../pi/holes.js'


export function cleanupTerminalModes(): void {
  return notBuilt('src/utils/shutdownRestoration.ts:22')
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
  return notBuilt('src/utils/shutdownRestoration.ts:101')
}


export function drainStdinForExit(): void {
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch (error) {
    passedOver(error)
  }
}
