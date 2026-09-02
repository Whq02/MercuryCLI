import { coerce } from 'semver'
import supportsHyperlinksLib from 'supports-hyperlinks'
import { env as detectedEnv } from '../../utils/env.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { gte } from '../../utils/semver.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { CURSOR_HOME, csi, ERASE_SCREEN, ERASE_SCROLLBACK } from '../termio/csi.js'


export function isSyncOutputForcedOff(): boolean {
  return isEnvTruthy(process.env.MERCURY_NO_SYNC_OUTPUT)
}

export function isSynchronizedOutputSupported(): boolean {
  if (isSyncOutputForcedOff()) return false
  return sniffSynchronizedOutput()
}

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

export function isDecrqmProbeSafe(): boolean {
  return process.env.TERM_PROGRAM !== 'Apple_Terminal'
}

let syncOutputSupported = sniffSynchronizedOutput()
let syncUpgradedByProbe = false

export function syncOutputSupportedNow(): boolean {
  if (isSyncOutputForcedOff()) return false
  return syncOutputSupported
}

export function syncOutputCapabilityNow(): boolean {
  return syncOutputSupported
}

export function upgradeSyncOutputSupport(): void {
  syncOutputSupported = true
  syncUpgradedByProbe = true
}

export function syncOutputStatusNow(): { armed: boolean; why: string } {
  if (isSyncOutputForcedOff()) {
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

let syncProbeOutstanding = false

export function markSyncProbeOutstanding(outstanding: boolean): void {
  syncProbeOutstanding = outstanding
}

export function shouldHoldFirstPaintForSyncProbe(): boolean {
  return syncProbeOutstanding && !syncOutputSupportedNow()
}


let xtversionName: string | undefined

export function setXtversionName(name: string): void {
  if (xtversionName === undefined) xtversionName = name
}

export function isXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode') return true
  return xtversionName?.startsWith('xterm.js') ?? false
}


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

let extendedKeysSupported = supportsExtendedKeys()
let extendedKeysProved = false
const extendedKeysListeners = new Set<() => void>()

export function extendedKeysSupportedNow(): boolean {
  return extendedKeysSupported
}

export function extendedKeysProvedNow(): boolean {
  return extendedKeysProved
}

export function upgradeExtendedKeysSupport(): void {
  const changed = !extendedKeysSupported || !extendedKeysProved
  extendedKeysSupported = true
  extendedKeysProved = true
  if (changed) for (const listener of [...extendedKeysListeners]) listener()
}

export function subscribeExtendedKeysSupport(listener: () => void): () => void {
  extendedKeysListeners.add(listener)
  return () => {
    extendedKeysListeners.delete(listener)
  }
}


export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

export function isProgressReportingAvailable(): boolean {
  const setting = getInitialSettings()?.progressReporting
  if (setting !== undefined) return setting
  if (!process.stdout.isTTY) return false
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


export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

export function streamingRevealSuppressed(
  reducedMotion: boolean,
  fullscreenActive: boolean,
): boolean {
  return reducedMotion || (hasCursorUpViewportYankBug() && !fullscreenActive)
}


export function regionScrollTrustedNow(): boolean {
  return !hasCursorUpViewportYankBug()
}


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


const CURSOR_HOME_WINDOWS = csi(0, 'f')

export function isModernWindowsTerminal(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (env.WT_SESSION) return true
  if (env.TERM_PROGRAM === 'vscode' && env.TERM_PROGRAM_VERSION) return true
  if (env.TERM_PROGRAM === 'mintty' || env.MSYSTEM) return true
  return false
}

export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    return isModernWindowsTerminal()
      ? ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
      : ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}
