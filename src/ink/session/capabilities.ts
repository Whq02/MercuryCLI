import { coerce } from 'semver'
import supportsHyperlinksLib from 'supports-hyperlinks'
import { env as detectedEnv } from '../../utils/env.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { gte } from '../../utils/semver.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { CURSOR_HOME, csi, ERASE_SCREEN, ERASE_SCROLLBACK } from '../termio/csi.js'

// ============================================================================
//  capabilities — Mercury terminal capabilities as DATA.
//
//  RESPONSIBILITY: every "can this terminal do X" decision, in one owner:
//  the pure env sniffs (synchronized output · extended keys · progress ·
//  hyperlinks · clear vocabulary · the win32 cursor-yank bug) and the two
//  LIVE-UPGRADEABLE facts (DEC 2026 support proven by the boot DECRQM probe;
//  the terminal's XTVERSION name, which survives SSH where TERM_PROGRAM does
//  not). Consumers read through stable function seams — the sync-output read
//  happens PER FRAME and must never be frozen into a const (#184).
//
//  CONTRACT: the CAPABILITY-MATRIX + LATCHES laws in
//  scripts/core-runtime/prove-session-contract.ts.
// ============================================================================

// ── synchronized output (DEC 2026 — atomic frames) ─────────────────────────

/** The operator's escape hatch for terminals whose DEC 2026 implementation
 *  is broken: forces wrapping OFF ahead of every other signal — the sniff,
 *  the force-on override, and the boot probe upgrade all lose to it. */
export function isSyncOutputForcedOff(): boolean {
  return isEnvTruthy(process.env.MERCURY_NO_SYNC_OUTPUT)
}

/** The env sniff. The force-off hatch returns first — an explicit operator
 *  "this terminal's 2026 is broken" beats every heuristic. tmux parses
 *  BSU/ESU but breaks atomicity by chunking — it returns next, deliberately
 *  BEFORE the force-on override (characterized behavior, pinned in the
 *  matrix law). */
export function isSynchronizedOutputSupported(): boolean {
  if (isSyncOutputForcedOff()) return false
  return sniffSynchronizedOutput()
}

/** The CAPABILITY sniff — the hatch-free half (TASK-017 S2,
 *  no-sync-output-hatch-demotes-host): what the terminal CAN do, distinct
 *  from whether the operator wants frames wrapped. tmux stays in here (its
 *  chunking is the terminal path's real limitation, not a preference). */
function sniffSynchronizedOutput(): boolean {
  if (process.env.TMUX) return false
  if (isEnvTruthy(process.env.MERCURY_FORCE_SYNC_OUTPUT)) return true

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true
  if (term === 'xterm-ghostty') return true
  if (term?.startsWith('foot')) return true
  if (term?.includes('alacritty')) return true
  if (process.env.ZED_TERM) return true
  if (process.env.WT_SESSION) return true
  const vte = process.env.VTE_VERSION
  if (vte && parseInt(vte, 10) >= 6800) return true
  return false
}

/** May the boot DECRQM 2026 probe be SENT at all? Apple Terminal does not
 *  consume the `$`-intermediate CSI form (DECRQM, `CSI ? Pd $ p`): it eats
 *  the parameters but PRINTS the trailing `p` in default ink at the cursor
 *  — parked at the frame tail after boot, so the static Boot face showed a
 *  stray bottom-left 'p' on every real launch (operator defect, forensics
 * `ESC[>0q ESC[?2026$p ESC[c` — XTVERSION and DA1 parse
 *  silently there; only the DECRQM leaks). Apple Terminal has no DEC 2026
 *  support to detect, so suppressing exactly this probe there loses
 *  nothing; every other probe in the boot batch stays. */
export function isDecrqmProbeSafe(): boolean {
  return process.env.TERM_PROGRAM !== 'Apple_Terminal'
}

// LIVE latch: seeded by the CAPABILITY sniff, upgradeable by the boot
// DECRQM 2026 probe (a sniff-missed terminal that answers the probe still
// gets atomic frames). Read via the functions every frame — never a frozen
// const. The latch records what the terminal CAN do; the force-off hatch
// gates EMISSION at each read, never knowledge — under the hatch the seed
// used to read false and the probe upgrade returned early, so setting the
// advertised rendering knob in a fingerprint-less Windows Terminal flipped
// the required 'full-profile Windows host' row to failing and disabled the
// requirement card's own self-clearing rescue (TASK-017 S2,
// no-sync-output-hatch-demotes-host).
let syncOutputSupported = sniffSynchronizedOutput()
let syncUpgradedByProbe = false

/** EMISSION: may a frame be wrapped in BSU/ESU right now? The hatch wins. */
export function syncOutputSupportedNow(): boolean {
  if (isSyncOutputForcedOff()) return false
  return syncOutputSupported
}

/** CAPABILITY: does the terminal speak DEC 2026 (sniffed or probe-proven)?
 *  The host-class verdict reads THIS — an operator's render preference must
 *  never demote the host. */
export function syncOutputCapabilityNow(): boolean {
  return syncOutputSupported
}

export function upgradeSyncOutputSupport(): void {
  // Knowledge is recorded even under the hatch (the requirement card's
  // self-clearing rescue depends on it); emission stays hatch-gated at
  // every read above.
  syncOutputSupported = true
  syncUpgradedByProbe = true
}

/** The doctor surface: armed/off plus the ONE reason that decided it. Armed
 *  is exactly the per-frame read; the why walks the same precedence the
 *  reads use (hatch > probe/force-on/sniff for armed; hatch > tmux > nothing
 *  for off). */
export function syncOutputStatusNow(): { armed: boolean; why: string } {
  if (isSyncOutputForcedOff()) {
    // The hatch names itself as the off reason — and the capability half
    // (a probe reply under the hatch) stays visible to the host verdict.
    return { armed: false, why: 'forced off (MERCURY_NO_SYNC_OUTPUT)' }
  }
  if (syncOutputSupported) {
    if (syncUpgradedByProbe) return { armed: true, why: 'DECRQM 2026 probe reply' }
    if (isEnvTruthy(process.env.MERCURY_FORCE_SYNC_OUTPUT) && !process.env.TMUX) {
      return { armed: true, why: 'forced on (MERCURY_FORCE_SYNC_OUTPUT)' }
    }
    return { armed: true, why: 'terminal identity sniff' }
  }
  if (process.env.TMUX) {
    return { armed: false, why: 'tmux re-chunks BSU/ESU — atomicity broken' }
  }
  return { armed: false, why: 'no terminal sniff match and no DECRQM 2026 probe reply' }
}

// The boot DECRQM 2026 probe's in-flight flag: while true and the latch is
// still off, the render scheduler may extend its boot-coalesce window a few
// frames so the reply (stdin I/O phase) beats the FIRST paint (timer phase)
// on a busy boot loop — the difference between a wrapped and an unwrapped
// first frame on sniff-missed terminals. Sniffed terminals are armed before
// the probe and never hold.
let syncProbeOutstanding = false

export function markSyncProbeOutstanding(outstanding: boolean): void {
  syncProbeOutstanding = outstanding
}

export function shouldHoldFirstPaintForSyncProbe(): boolean {
  return syncProbeOutstanding && !syncOutputSupportedNow()
}

// ── XTVERSION (the SSH-surviving terminal identity) ─────────────────────────

let xtversionName: string | undefined

/** Record the XTVERSION reply. Write-once — re-probes can't flap identity. */
export function setXtversionName(name: string): void {
  if (xtversionName === undefined) xtversionName = name
}

/** xterm.js-based terminal (VS Code/Cursor/code-server)? Combines the env
 *  check (fast, not SSH-forwarded) with the probe result (SSH-safe). */
export function isXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode') return true
  return xtversionName?.startsWith('xterm.js') ?? false
}

// ── extended key reporting (kitty protocol / modifyOtherKeys) ───────────────

/** Terminals that honor the enables AND emit sequences our parser handles;
 *  everything else keeps the legacy encoding (some terminals honor the
 *  enable then emit codepoints nothing expects — #23350). tmux is listed
 *  because it accepts modifyOtherKeys without forwarding the kitty enable. */
const EXTENDED_KEYS_TERMINALS = [
  'iTerm.app',
  'kitty',
  'WezTerm',
  'ghostty',
  'tmux',
  'windows-terminal',
]

export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(detectedEnv.terminal ?? '')
}

// LIVE latch: seeded by the identity sniff, upgradeable by the boot kitty-
// keyboard probe (a CSI ? u reply proves the protocol is spoken, whatever
// the current flag value — terminals the list never heard of get real
// chords). Same shape as the sync-output latch: read through the function
// on every use, never frozen into a const.
let extendedKeysSupported = supportsExtendedKeys()
let extendedKeysProved = false
// Surfaces that ADVERTISE a chord the latch decides (the composer's newline
// hint) subscribe here: the probe reply can land after their first paint,
// and a hint painted from the pre-reply value would name the wrong key
// until something else re-rendered it.
const extendedKeysListeners = new Set<() => void>()

export function extendedKeysSupportedNow(): boolean {
  return extendedKeysSupported
}

/** Probe-proved (a live reply) as opposed to identity-declared. */
export function extendedKeysProvedNow(): boolean {
  return extendedKeysProved
}

export function upgradeExtendedKeysSupport(): void {
  const changed = !extendedKeysSupported || !extendedKeysProved
  extendedKeysSupported = true
  extendedKeysProved = true
  if (changed) for (const listener of [...extendedKeysListeners]) listener()
}

/** Notifies on every latch upgrade; returns the unsubscribe. */
export function subscribeExtendedKeysSupport(listener: () => void): () => void {
  extendedKeysListeners.add(listener)
  return () => {
    extendedKeysListeners.delete(listener)
  }
}

// ── progress reporting (OSC 9;4) ────────────────────────────────────────────

export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

export function isProgressReportingAvailable(): boolean {
  const setting = getInitialSettings()?.progressReporting
  if (setting !== undefined) return setting
  if (!process.stdout.isTTY) return false
  // Windows Terminal reads OSC 9;4 as a NOTIFICATION — excluded.
  if (process.env.WT_SESSION) return false
  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) {
    return true
  }
  const version = coerce(process.env.TERM_PROGRAM_VERSION)
  if (!version) return false
  if (process.env.TERM_PROGRAM === 'ghostty') return gte(version.version, '1.2.0')
  if (process.env.TERM_PROGRAM === 'iTerm.app') return gte(version.version, '3.6.6')
  return false
}

// ── the win32 viewport-yank bug ─────────────────────────────────────────────

/** conhost follows cursor-up into scrollback (microsoft/terminal#14774) —
 *  WT_SESSION catches WSL whose output still routes through conhost. */
export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

/** The live streaming reveal's suppression — the yank bug SURFACE-SPLIT
 *  (FN-016 R2). The named hazard is cursor-up INTO SCROLLBACK, which only
 *  the main screen has: the alternate screen paints the tail on every
 *  platform, and only the inline surface keeps the conhost guard. Reduced
 *  motion suppresses on both surfaces (the operator's own word). This is
 *  the ONE owner of the reveal gate; `regionScrollTrustedNow` below is
 *  DELIBERATELY not surface-split — ConPTY re-synthesizes region scrolls
 *  on both screens. */
export function streamingRevealSuppressed(
  reducedMotion: boolean,
  fullscreenActive: boolean,
): boolean {
  return reducedMotion || (hasCursorUpViewportYankBug() && !fullscreenActive)
}

// ── DECSTBM region-scroll truth ─────────────────────────────────────────────

/** May the writer trust a DECSTBM + SU/SD region scroll to actually MOVE
 *  rows? ConPTY re-synthesizes the screen instead of forwarding the region
 *  scroll, so the writer's model shifts while the terminal's rows stay —
 *  every subsequent diff then lands on desynced rows (the
 *  phantom-region-scroll class: cockpit chrome doubling, modal residue,
 *  whole turns painted twice). This is a SEPARATE fact from synchronized
 *  output: WT_SESSION advertises DEC 2026 (frames arrive atomically) while
 *  the region scroll inside those frames still never happens. The same
 *  conhost lineage as the viewport-yank bug, so the same detection shape. */
export function regionScrollTrustedNow(): boolean {
  return !hasCursorUpViewportYankBug()
}

// ── OSC 8 hyperlinks ────────────────────────────────────────────────────────

/** Terminals supporting OSC 8 that the supports-hyperlinks lib misses.
 *  Checked against TERM_PROGRAM and LC_TERMINAL (tmux preserves the latter
 *  while overwriting the former). */
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
]

type EnvLike = Record<string, string | undefined>
type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/** OSC 8 support on stdout. The lib leg computes at LIB IMPORT TIME (env
 *  changes after import are invisible there — characterized); the additional
 *  detection reads live. `options` overrides both legs for tests. */
export function supportsHyperlinks(options?: SupportsHyperlinksOptions): boolean {
  const stdoutSupported = options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) return true
  const env = options?.env ?? process.env
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) return true
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) return true
  if (env['TERM']?.includes('kitty')) return true
  return false
}

// ── the clear-terminal vocabulary ───────────────────────────────────────────

// HVP — the legacy Windows cursor home.
const CURSOR_HOME_WINDOWS = csi(0, 'f')

export function isModernWindowsTerminal(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (env.WT_SESSION) return true
  // VS Code's integrated terminal on Windows rides ConPTY.
  if (env.TERM_PROGRAM === 'vscode' && env.TERM_PROGRAM_VERSION) return true
  // mintty (GitBash/MSYS2/Cygwin) — TERM_PROGRAM on 3.1.5+, MSYSTEM otherwise.
  if (env.TERM_PROGRAM === 'mintty' || env.MSYSTEM) return true
  return false
}

/** The full-clear sequence for this terminal: modern terminals clear
 *  scrollback too (ESC[3J); legacy Windows console cannot. */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    return isModernWindowsTerminal()
      ? ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
      : ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

