// ============================================================================
//  utils/cockpit/oasisBg — THE terminal-ground lifecycle owner (OSC 11).
//
//  Why the ground exists: terminal emulators paint their WINDOW PADDING with
//  the profile background — cells can never reach it, so the oasis retint left
//  a lighter fringe around every screen (the operator's "corners revert to old
//  terminal"), and the live session sat on whatever ground the profile had.
//  OSC 11 sets the terminal's default background from inside the app —
//  padding included — so the ground follows Mercury onto any terminal
//  (Apple Terminal, iTerm2, Windows Terminal, kitty all honor it; unknown
//  terminals ignore the sequence harmlessly).
//
//  Fill law: this module is the ONE owner of the terminal's
//  default-background channel. Three writers would otherwise compete — this module
//  (the resolved appearance's family ground at boot — pure black on the
//  True Black default, the oasis NIGHT on the oasis appearance — / OSC 111
//  at exit), warmBackground.ts (query-original →
//  paint → restore-exact at cleanupTerminalModes), and the launcher splash
//  (its own `]11;#070D12` before the handoff). The recorded failure modes:
//    • the warm-bg OSC 11 query is SENT after the oasis paint, so its "user
//      original" capture was Mercury's own canvas — an exit then "restored"
//      NIGHT over the user's profile whenever the OSC 111 reset didn't run
//      last (dark boot + live switch to a light family = terminal left dark);
//    • two exit seams (cleanupTerminalModes + the process-exit hook) each
//      wrote their own restore value in their own order;
//    • a launcher handoff onto a session that never paints (light family)
//      left the splash's ground set forever.
//  Now: ONE saved original (trusted only when captured while unpainted), ONE
//  exactly-once exit restoration shared by every exit seam, and the launcher
//  handoff is adopted — Mercury heals the splash's ground even when it never
//  painted its own. warmBackground.ts is a thin facade over this owner.
//
//  Gates: MERCURY_OASIS_BG=0 opts out entirely; TTY-only (a piped/headless
//  run must never emit control bytes — the headless-brief-leak class);
//  TERM=dumb|linux stays untouched.
// ============================================================================
import { writeSync } from 'fs'
import { groundFamilyFor, NIGHT } from '../../components/mercuryPalette.js'
import { launcherHeldAtBoot } from '../../ink/launcherAltHold.js'
import { getGlobalConfig } from '../config.js'
import { isDarkThemeFamily } from '../mercuryTokens.js'
import { DEFAULT_THEME_SETTING, resolveThemeSetting } from '../systemTheme.js'
import type { ThemeName } from '../theme.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The concrete theme family the ground follows (config → resolved). */
function concreteTheme(): ThemeName {
  try {
    return resolveThemeSetting(getGlobalConfig().theme)
  } catch {
    return DEFAULT_THEME_SETTING // config unreadable at this instant — the default appearance
  }
}

export function oasisBgEnabled(
  isTTY: boolean = Boolean(process.stdout.isTTY),
  theme: ThemeName = concreteTheme(),
): boolean {
  // Live process.env read (proofs mutate + restore it, the registry ratchet
  // requires the literal consumer site).
  if (flagEnv('MERCURY_OASIS_BG') === '0') return false
  if (!isTTY) return false
  if (/^(dumb|linux)$/.test(process.env.TERM || '')) return false
  // THEME-AWARE: the oasis ground is the DARK identity
  // canvas — a light theme family keeps the operator's own profile ground
  // instead of getting a dark canvas forced under light-palette text.
  if (!isDarkThemeFamily(theme)) return false
  return true
}

/** The set sequence — the flat ground of the given appearance's family
 *  (mercuryPalette groundFamilyFor: oasis NIGHT for dark, #000000 for
 *  true-black — the default appearance). */
export function oasisBgEnter(theme: ThemeName = DEFAULT_THEME_SETTING): string {
  return `\x1b]11;${groundFamilyFor(theme).NIGHT}\x07`
}

/** The reset sequence — hands the user's own profile ground back. */
export function oasisBgExit(): string {
  return `\x1b]111\x07`
}

/** An explicit set sequence for an arbitrary spec (the exact-restore path). */
function oasisBgSet(spec: string): string {
  return `\x1b]11;${spec}\x07`
}

// ── the one ground state ────────────────────────────────────────────────────
/** This process currently holds the ground channel with its own canvas. */
let painted = false
/** The exact spec THIS process painted last — the dark ⇄ true-black switch
 *  changes the ground VALUE while the channel stays held, and the sync must
 *  repaint on a value change, never on a mere re-resolve. */
let paintedSpec: string | undefined
/** WHO painted (verify wave): the theme-sync release applies only to the
 *  OASIS acquisition — the opt-in warm canvas (family-agnostic by contract)
 *  must survive a light-family sync and release at exit with its exact
 *  original, exactly as the legacy path did. */
let paintedBy: 'oasis' | 'warm' | null = null
/** The terminal's OWN ground, from the OSC 11 query reply — stored ONLY when
 *  the query was sent while unpainted, so it can never be our own canvas. */
let exactOriginal: string | undefined
/** Snapshot of `painted` at the moment the OSC 11 query was SENT — the reply
 *  arrives after our boot paint on dark families, so reply-time state lies. */
let paintedAtQuerySend: boolean | undefined
/** Exactly-once exit latch — cleanupTerminalModes AND the process-exit hook
 *  both call restore; the first write wins, the second is a no-op. */
let exitRestored = false
/** A restore/release ALREADY reached the terminal this session (e.g. a live
 *  dark→light theme switch) — the channel is healed; the launcher-handoff
 *  exit heal must not write a second reset over it. */
let channelHealed = false

/** Called by App.tsx immediately before the warm-bg OSC 11 query is sent —
 *  latches whether the reply can be trusted as the USER'S ground. */
export function markOriginalGroundQuerySent(): void {
  paintedAtQuerySend = painted
}

/**
 * The warm-canvas acquisition (MERCURY_WARM_BG, via the warmBackground facade):
 * the OSC 11 query replied with `spec`. If the query was sent while this
 * process had already painted, the reply is our own canvas — discard it and
 * keep the OSC 111 restore strategy (the canvas is already NIGHT; painting
 * again would be a no-op). Only an unpainted-at-send reply is the user's real
 * ground: save it for byte-exact restoration and paint the warm canvas.
 */
export function noteOriginalGroundReply(
  spec: string,
  write: (s: string) => void = s => process.stdout.write(s),
): void {
  if (!spec) return
  if (paintedAtQuerySend !== false) return // sent-while-painted (or never marked) — reply is ours
  if (exactOriginal === undefined && !launcherHeldAtBoot()) {
    // A launcher handoff means the SPLASH already recoloured the ground
    // before this process existed — the reply is the splash's #070D12, not
    // the user's profile. Only a launcher-free reply is the user's ground.
    exactOriginal = spec
  }
  if (!painted) {
    painted = true
    paintedBy = 'warm'
    paintedSpec = NIGHT
    write(oasisBgSet(NIGHT))
  }
}

/**
 * Re-sync the ground to the CURRENT theme — called when the operator applies
 * a theme change live (/theme, /appearance). Dark family ⇒ ensure the oasis
 * canvas is painted; light family ⇒ hand the user's ground back (byte-exact
 * when the query captured it, OSC 111 otherwise). Idempotent both ways; a
 * session that never painted never emits a restore.
 */
export function syncOasisBgToTheme(
  theme: ThemeName,
  write: (s: string) => void = s => process.stdout.write(s),
): void {
  if (isDarkThemeFamily(theme)) {
    if (!oasisBgEnabled(Boolean(process.stdout.isTTY), theme)) return
    const spec = groundFamilyFor(theme).NIGHT
    if (!painted) {
      painted = true
      paintedBy = 'oasis'
      paintedSpec = spec
      write(oasisBgSet(spec))
    } else if (paintedBy === 'oasis' && paintedSpec !== spec) {
      // dark ⇄ true-black: the channel stays held, the VALUE repaints —
      // the warm canvas (paintedBy 'warm', family-agnostic) never does.
      paintedSpec = spec
      write(oasisBgSet(spec))
    }
  } else if (painted && paintedBy === 'oasis') {
    // The warm canvas (opt-in, family-agnostic) is NOT the theme's ground —
    // it survives a light-family sync and restores at exit (verify wave).
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    write(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
  }
}

/**
 * THE exit restoration — exactly-once, shared by every exit seam
 * (cleanupTerminalModes on graceful/signal paths, the process-exit hook as
 * the safety net). Synchronous by default (writeSync) so it completes before
 * process.exit.
 *
 * • painted ⇒ write the user's exact ground when the query captured it,
 *   else OSC 111 (reset to profile).
 * • never painted but the LAUNCHER handed this process a held screen ⇒ the
 *   splash set its own ground before the exec — heal it with OSC 111 even
 *   though this process never painted (the light-family handoff leak).
 * • anything else ⇒ the terminal was never recoloured — write nothing.
 */
export function exitOasisBg(write?: (s: string) => void): void {
  if (exitRestored) return
  const w =
    write ??
    ((s: string) => {
      try {
        if (process.stdout.isTTY) writeSync(1, s)
        else if (process.stderr.isTTY) writeSync(2, s)
      } catch {
        /* terminal gone (SIGHUP) — nothing to restore to */
      }
    })
  if (painted) {
    exitRestored = true
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    w(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
  } else if (launcherHeldAtBoot() && !channelHealed && splashCouldHaveRecoloured()) {
    exitRestored = true
    w(oasisBgExit())
  }
}

/** The heal fires only when the SPLASH could actually have set the ground
 *  (verify wave: "held" ≠ "held AND recoloured" — a spurious OSC 111 would
 *  discard an externally-set dynamic ground). Mirrors the splash's own
 *  OSC-11 predicate (round 7, mercury-splash.mjs OSC11_GROUND): skipped
 *  under the MERCURY_OASIS_BG opt-out and everywhere the splash's TRUECOLOR
 *  law is off — TERM dumb|linux, MERCURY_TRUECOLOR=0 (legacy spelling via
 *  the registry alias), and NO_COLOR-without-FORCE_COLOR. */
function splashCouldHaveRecoloured(): boolean {
  if (flagEnv('MERCURY_OASIS_BG') === '0') return false
  if (flagEnv('MERCURY_TRUECOLOR') === '0') return false
  if (/^(dumb|linux)$/.test(process.env.TERM || '')) return false
  const noColor = process.env.NO_COLOR
  const forceColor = process.env.FORCE_COLOR
  if (noColor && noColor.length > 0 && !(forceColor && forceColor.length > 0)) return false
  return true
}

/** Test-only: reset the owner between cases. */
export function _resetGroundForTest(): void {
  painted = false
  paintedBy = null
  paintedSpec = undefined
  exactOriginal = undefined
  paintedAtQuerySend = undefined
  exitRestored = false
  channelHealed = false
}
