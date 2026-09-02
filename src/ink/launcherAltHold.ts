import { deleteFlagEnv, flagEnv } from '../substrate/flagRegistry.js'
import { noteModesImported, noteModeReleased } from './root/terminalModeLedger.js'
// launcherAltHold — the ONE-SHOT "the launcher already holds the alternate
// buffer" marker (UI-logic audit, finding #11b — the boot black
// beat).
//
// The Mercury launcher's splash hands the session over INSIDE the alternate
// screen: it paints a dim "starting…" hold frame, parks the SGR ink,
// and execs the binary with MERCURY_ALT_HELD=1. The REPL's root
// <AlternateScreen> would otherwise re-enter (?1049h — a buffer CLEAR on iTerm2) and
// 2J immediately, wiping the hold long before React's first frame landed —
// the boot black beat. With the marker, the outermost mount SKIPS the
// re-enter/clear and arms ink.armAltScreenTakeover() instead: the first frame
// prepends its erase atomically (one write), so the hold is replaced by a
// fully-painted frame.
//
// One-shot semantics: consumed by the FIRST outermost AlternateScreen mount;
// later mounts (ctrl+o overlays, pane drill-ins, a full REPL remount) behave
// exactly as before. If the process exits WITHOUT anything consuming the hold
// (an early boot error, --print fast paths, onboarding quit before the REPL
// mounts), the exit handler below releases the held buffer so the operator
// is never stranded on a frozen splash frame with a hidden cursor.

let heldPending = flagEnv('MERCURY_ALT_HELD') === '1'

// Consume the env immediately: child processes (daemon spawns, workers,
// subshells) must never inherit a claim about THIS process's terminal.
if (heldPending) deleteFlagEnv('MERCURY_ALT_HELD')

// 3.6.2: the transferred set is EXACTLY what the splash's
// hold frame acquires (?1049h · ?1007h · ?25l — never bracketed paste,
// mouse, or keyboard protocol; the ground OSC rides oasisBg's own mirror).
// The ledger records the import so release consults obligations instead of
// a hand-written subset — the class where alternate-scroll stayed armed.
const TRANSFERRED_MODES = ['alt-screen', 'alternate-scroll', 'cursor-hidden'] as const
if (heldPending) noteModesImported('launcher-splash', TRANSFERRED_MODES)

// Immutable boot fact: the launcher DID hand this process a held
// screen — readable after the one-shot marker is consumed. The terminal-ground
// owner (utils/cockpit/oasisBg.ts) uses it to heal the splash's own OSC 11
// ground on exit even when this process never painted one (light families).
const heldAtBoot = heldPending

/** True iff this process was booted by the launcher with a held alt buffer. */
export function launcherHeldAtBoot(): boolean {
  return heldAtBoot
}

/** True while the launcher-held buffer has not been taken over yet. */
export function launcherAltHoldPending(): boolean {
  return heldPending
}

/** One-shot: returns true exactly once when the launcher holds the buffer. */
export function consumeLauncherAltHold(): boolean {
  const v = heldPending
  heldPending = false
  if (v) {
    // The app's root screen session takes the modes over — the obligations
    // transfer to its normal lifecycle (it releases them at its own exit).
    for (const mode of TRANSFERRED_MODES) noteModeReleased('launcher-splash', mode)
  }
  return v
}

/**
 * Release the held buffer RIGHT NOW. For paths that will
 * never take the screen over — `-p`/`--print`, `--help`, subcommands, a
 * non-TTY stdout — releasing at exit is too late: everything those paths
 * print lands INSIDE the held alt buffer and vanishes with it. cli.tsx calls
 * this as soon as the argv says "no takeover", and main.tsx's commander
 * error writer calls it before printing a usage error, so output always
 * lands on the main screen. TTY-aware: restoration bytes go to whichever of
 * stdout/stderr is the terminal — a piped stream never gets control bytes
 * (the machine-output purity contract).
 */
export function releaseLauncherAltHoldNow(): void {
  if (!heldPending) return
  heldPending = false
  // 3.6.2 (UI-037): release EXACTLY the transferred obligations — SGR reset,
  // alternate-scroll off (?1007l — the previously-missed subset member: the
  // hold frame arms it, so a no-takeover exit left wheel arrows synthesized
  // in the operator's shell), alt screen closed, cursor back.
  const RESTORE = '\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h'
  try {
    if (process.stdout.isTTY) process.stdout.write(RESTORE)
    else if (process.stderr.isTTY) process.stderr.write(RESTORE)
    // neither is a terminal — nothing to restore
  } catch {
    /* stream gone — nothing to restore */
  }
  for (const mode of TRANSFERRED_MODES) noteModeReleased('launcher-splash', mode)
}

// Early-exit safety net: a boot that dies before any AlternateScreen mounts
// would otherwise strand the terminal in the splash's held buffer (hidden
// cursor, parked ink — the "type reset" screen). Fires only if nothing
// consumed the hold. SGR reset first so the splash's parked (concealed) ink
// can't bleed into the restored main screen. NOTE: this module is
// import-free and is force-evaluated EARLY by src/entrypoints/cli.tsx — the
// net would otherwise arm only when the REPL screen chunk loaded, so every pre-REPL
// exit (flag typo, -p under the launcher, setup-screen quit) stranded the
// terminal.
if (heldPending) {
  process.on('exit', () => {
    releaseLauncherAltHoldNow()
  })
}
