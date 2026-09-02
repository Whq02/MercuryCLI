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

/**
 * The heavy half of process shutdown: terminal-mode restoration and the
 * resume hint. Split from gracefulShutdown.ts (the stage-1 handler
 * installer) because this module's static closure IS the interactive world —
 * the ink runtime, the termio byte owners, the config barrel and session
 * storage — and stage 1 evaluates the installer on EVERY process, sidecars
 * and daemons included. gracefulShutdown.ts reaches this module only at fire
 * time (a synchronous require on the exit paths, an idle prefetch on
 * interactive boots); prove-boot-contract.ts pins that shape. Nothing else
 * imports it.
 */

// ---------------------------------------------------------------------------
// Terminal-mode restoration
// ---------------------------------------------------------------------------

/**
 * Every mode close consults the obligation ledger of modes this process
 * actually armed: nothing is released that was never acquired here, and
 * nothing twice once its owner released it. An owner that died before
 * releasing leaves its row open — exactly when this path releases it. All
 * writes are synchronous so they complete before exit. The whole ordered
 * sequence sits inside ONE guard: a throw part-way abandons the rest (the
 * terminal is usually already gone when that happens).
 */
export function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) return
  try {
    const inst = instances.get(process.stdout)
    let open = new Set(shutdownReleaseObligations())

    // Mouse tracking first, before the unmount walk: stopping the event
    // stream costs a terminal round trip that can overlap the unmount;
    // issued later, in-flight events land while the terminal is being put
    // back into cooked mode and get echoed or handed to the shell.
    if (open.has('mouse-tracking')) {
      writeSync(1, DISABLE_MOUSE_TRACKING)
      noteModeSettledEverywhere('mouse-tracking')
    }

    // Leave the alt screen by UNMOUNTING the renderer rather than writing the
    // exit directly: the renderer already registered its unmount with the
    // exit hook (a second alt-screen exit performs a second cursor restore
    // that drags the cursor above the resume hint), and the final render
    // must happen while the alt buffer is still active.
    if (inst?.isAltScreenActive) {
      try {
        inst.unmount()
      } catch {
        // Manual close of the alt-session obligations: alternate scroll only
        // when its row is still open, the alt-screen exit unconditionally
        // (the resume hint must reach the main buffer even if the ledger is
        // wrong).
        open = new Set(shutdownReleaseObligations())
        if (open.has('alternate-scroll')) writeSync(1, DISABLE_ALTERNATE_SCROLL)
        writeSync(1, EXIT_ALT_SCREEN)
        noteModeSettledEverywhere('alternate-scroll')
        noteModeSettledEverywhere('alt-screen')
      }
    }

    // The unmount walk can admit events: drain them, then mark the renderer
    // detached so the exit hook's deferred unmount early-returns instead of
    // emitting further alt-screen exits over the resume hint.
    inst?.drainStdin()
    inst?.detachForShutdown()

    // Whatever the component owners released is now settled; exactly what
    // remains is what this path still owes.
    open = new Set(shutdownReleaseObligations())
    if (open.has('kitty-kbd')) {
      // Both keyboard-protocol forms; terminals ignore the one they lack.
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
      // Re-armed during the unmount walk.
      writeSync(1, DISABLE_MOUSE_TRACKING)
      noteModeSettledEverywhere('mouse-tracking')
    }
    if (open.has('cursor-hidden')) {
      writeSync(1, SHOW_CURSOR)
      noteModeSettledEverywhere('cursor-hidden')
    }

    // A terminal that was never recoloured is untouched by this.
    restoreOriginalBackground()
    // A progress indicator left armed makes the emulator chime on focus.
    writeSync(1, CLEAR_ITERM2_PROGRESS)
    if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
    // A user who declined title changes gets no title write at all — the
    // clearing one included.
    if (resolveTerminalExperience().terminalTitle.effective) {
      if (process.platform === 'win32') process.title = ''
      else writeSync(1, CLEAR_TERMINAL_TITLE)
    }
  } catch {
    // The terminal may already be gone.
  }
}

// ---------------------------------------------------------------------------
// Resume hint
// ---------------------------------------------------------------------------

let resumeHintPrinted = false

/** SL-7: the resume hint is PASTED into the host's shell, so
 *  its title argument is quoted by the host's own rules — the display's
 *  truth is "resolves back to this exact title where the operator pastes
 *  it". POSIX shells keep the exact bash-family double-quote escapes they
 *  always had (byte-identical hint on mac/linux/wsl); on win32 the
 *  documented home is PowerShell 7 (AGENTS.md prerequisites), whose string
 *  literal is the single quote with '' doubling — the old backslash-escaped
 *  double quotes resolved to a DIFFERENT title there (backslash is not a
 *  PS escape). Pure; platform injectable for the pin. */
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

/** At most once per process; the flag is set only after a successful write. */
export function printResumeHint(): void {
  if (resumeHintPrinted) return
  if (!process.stdout.isTTY) return
  if (!getIsInteractive()) return
  if (isSessionPersistenceDisabled()) return
  const sessionId = getSessionId()
  // No session file (a subcommand run, for instance): nothing to resume.
  if (!sessionIdExists(sessionId)) return
  const title = getCurrentSessionTitle(sessionId)
  const argument = resumeHintArgument(title, sessionId)
  try {
    writeSync(1, `\nResume this session with:\n${chalk.dim(`${binaryName()} --resume ${argument}`)}\n`)
    resumeHintPrinted = true
  } catch {
    // Ignored.
  }
}

// ---------------------------------------------------------------------------
// The forced-exit stdin drain
// ---------------------------------------------------------------------------

/**
 * Drain through the instance's own drain: the standalone drain defaults to
 * the process input stream and early-returns when input is piped, while the
 * instance knows about a terminal opened directly.
 */
export function drainStdinForExit(): void {
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {
    // Ignored.
  }
}
