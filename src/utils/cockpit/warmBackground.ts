// ============================================================================
//  cockpit/warmBackground — the OPTIONAL, default-OFF OSC 11 warm canvas.
//
//  Fill law: this module is now a THIN FACADE over the ONE
//  terminal-ground lifecycle owner (utils/cockpit/oasisBg.ts). It would otherwise keep
//  its own saved-original + restore path, which raced the oasis ground three
//  ways (the query reply captured Mercury's OWN canvas whenever the oasis
//  painted first; two exit seams wrote competing restore values; a mid-session
//  dark→light theme switch left the terminal recoloured after exit). The
//  feature contract is unchanged:
//
//    1. On startup App.tsx QUERIES the terminal's current background via
//       OSC 11 (`ESC]11;?`) — after telling the owner the query was sent, so
//       the owner knows whether the reply can be trusted as the USER'S ground.
//    2. The warm NIGHT canvas is painted ONLY off a real reply.
//    3. Restoration is the owner's exactly-once exit path: byte-exact when a
//       trustworthy original was captured, OSC 111 (profile reset) otherwise.
//
//  Gated behind MERCURY_WARM_BG=1 on Mercury (default OFF). The only
//  unrecoverable path is SIGKILL (kill -9) — an accepted UNIVERSAL
//  terminal-teardown limitation. No new hex: the canvas is the NIGHT token.
// ============================================================================

import { NIGHT } from '../../components/mercuryPalette.js'
import { osc } from '../../ink/termio/osc.js'
import { isEnvTruthy } from '../envUtils.js'
import { _resetGroundForTest, exitOasisBg, noteOriginalGroundReply } from './oasisBg.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// OSC 11 — set/query the terminal default background colour.
const OSC_BG = 11

/** Flag-gated and DEFAULT-OFF. Opt in with MERCURY_WARM_BG=1. */
export function isWarmBackgroundEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_WARM_BG'))
}

/**
 * The OSC 11 query replied — hand the spec to the ground owner. The owner
 * decides whether the reply is the user's real ground (query sent while
 * unpainted, no launcher handoff) or our own/the splash's canvas, and paints
 * the warm NIGHT ground when it isn't already painted.
 */
export function applyWarmBackground(
  originalSpec: string,
  stdout: NodeJS.WriteStream,
): void {
  noteOriginalGroundReply(originalSpec, s => stdout.write(s))
}

/**
 * Restore the terminal ground — delegates to the owner's exactly-once exit
 * restoration. Synchronous (writeSync inside the owner) so it completes
 * before process.exit; always safe to call unconditionally from
 * cleanupTerminalModes() — a terminal we never recoloured is untouched.
 */
export function restoreOriginalBackground(): void {
  exitOasisBg()
}

/** Test-only: reset the ground owner's state between cases. */
export function _resetWarmBackgroundForTest(): void {
  _resetGroundForTest()
}
