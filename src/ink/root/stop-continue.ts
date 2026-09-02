// ============================================================================
//  stop-continue.ts — the terminal host's STOP / CONTINUE hygiene: the one
//  owner of what happens to the terminal when the process is stopped by a
//  job-control signal and when it is continued.
//
//  A stopped process runs no JavaScript: whatever the terminal is left
//  holding at the moment of the stop is what the shell prompt inherits —
//  and what the shell keeps if the stopped job is then killed (a killed
//  stopped process never runs an exit path either). Mouse tracking left
//  armed floods the prompt with motion reports; the alternate screen left
//  entered hides the prompt; a hidden cursor and raw mode make the shell
//  unusable. So a stop RESTORES FIRST, then really stops.
//
//  The stop-time disarm IS the exit-time disarm — the teardown suite
//  (teardown.ts, the one ordered disarm list; prove-root-contract pins it) —
//  so a job stopped at the prompt looks exactly like one that exited, and
//  there is no second list to drift. The continue-time re-arm is the
//  non-destructive mode re-assert (screen-session.ts — the one arming
//  owner) — extended keys, bracketed paste, focus reporting, and on the
//  alternate screen the mouse family + alternate scroll; the destructive
//  alternate-screen re-entry and the full repaint stay the host's own
//  SIGCONT re-entry. Raw mode rides beside both: off at the stop, on again
//  at the continue.
//
//  The signal protocol: the handler restores, detaches itself, and re-raises
//  the SAME signal with the default disposition restored, so the shell sees
//  a normally stopped job (`suspended` / `suspended (tty input)`); the
//  process continues past the re-raise on SIGCONT and re-attaches. SIGTTIN
//  and SIGTTOU mean the process is NOT the terminal's foreground group:
//  the cooked-mode restore is skipped there — a tcsetattr from a background
//  group draws SIGTTOU, a second stop the moment `fg` continued the first
//  (a job-control shell restores its own line discipline at the stop and
//  the job's again at `fg` regardless).
//
//  Windows has no job-control stop signals (SIGTSTP/SIGTTIN/SIGTTOU do not
//  exist there): no listener, no throw.
// ============================================================================
import { runTeardownSuite, type TeardownHost } from './teardown.js'
import { reassertModesBytes } from './screen-session.js'

/** The POSIX job-control stop signals a process can catch (SIGSTOP cannot). */
export const POSIX_STOP_SIGNALS = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as const
export type StopSignal = (typeof POSIX_STOP_SIGNALS)[number]

/** The stop signals exist only off Windows. */
export function stopSignalsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function isStopSignal(signal: string): signal is StopSignal {
  return (POSIX_STOP_SIGNALS as readonly string[]).includes(signal)
}

/** SIGTSTP is the FOREGROUND stop (ctrl+z, `kill -TSTP`): the process still
 *  owns the terminal, so it may touch the line discipline and read the
 *  input queue. SIGTTIN / SIGTTOU mean it does NOT: a tcsetattr or a read
 *  from a background group draws the same signal again — with the handler
 *  off, a second stop in the middle of the restore, before the cursor is
 *  shown — so the raw-mode restore and the input drain are foreground-only.
 *  The shell fixes the line discipline in every case; the few in-flight
 *  report bytes go to whoever owns the terminal. */
export function stopIsForeground(signal: StopSignal): boolean {
  return signal === 'SIGTSTP'
}

export type StopStdin = {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode(mode: boolean): unknown
}

export type StopRestoreReceipt = {
  /** Raw mode was on and this restore turned it off (the continue re-arms it). */
  rawModeOff: boolean
}

/**
 * The stop-time restore: the exit teardown suite (mouse off, alternate
 * screen left, extended keys off, focus + bracketed paste off, cursor
 * shown — every disable unconditional, the alt exit on the host's belief),
 * then raw mode off for a foreground stop. Every write is the host's
 * synchronous writer — the process is about to stop and nothing
 * asynchronous would land.
 */
export function restoreTerminalForStop(
  signal: StopSignal,
  host: TeardownHost,
  stdin: StopStdin,
): StopRestoreReceipt {
  const foreground = stopIsForeground(signal)
  runTeardownSuite(foreground ? host : { ...host, drainStdin: () => {} })
  let rawModeOff = false
  if (foreground && stdin.isTTY === true && stdin.isRaw === true) {
    try {
      stdin.setRawMode(false)
      rawModeOff = true
    } catch {
      // A terminal that refuses the mode change is left as it is.
    }
  }
  return { rawModeOff }
}

/**
 * The continue-time re-arm bytes: the one arming owner's non-destructive
 * re-assert — extended keys (pop-before-push), bracketed paste, focus
 * reporting, and on the alternate screen the mouse family + alternate
 * scroll. The host follows it with its destructive alternate-screen
 * re-entry (the erase + the full repaint) when the screen is alt.
 */
export function continueRearmBytes(opts: {
  extendedKeys: boolean
  altActive: boolean
  mouseTracking: boolean
}): string {
  return reassertModesBytes(opts)
}
