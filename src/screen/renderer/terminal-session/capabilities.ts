import { coerce } from 'semver'
import supportsHyperlinksLib from 'supports-hyperlinks'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { env as detectedEnv } from '../../../platform/environment/env.js'
import { isEnvTruthy } from '../../../platform/environment/envUtils.js'
import { gte } from '../../../platform/primitives/semver.js'
import { getInitialSettings } from '../../../platform/settings/settings.js'
import { CURSOR_HOME, csi, ERASE_SCREEN } from '../termio/csi.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { isLegacyWindowsConsole, isModernWindowsTerminalHost, isWindowsTerminalHost } from '../../../platform/host-os/terminal.js'


export function isSyncOutputForcedOff(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_NO_SYNC_OUTPUT'))
}

export function isSynchronizedOutputSupported(): boolean {
  if (isSyncOutputForcedOff()) return false
  return sniffSynchronizedOutput()
}

const SYNC_PROGRAMS = new Set([
  'iTerm.app', 'WezTerm', 'WarpTerminal', 'ghostty', 'contour', 'vscode', 'alacritty',
])

function sniffSynchronizedOutput(): boolean {
  const env = hostEnv()
  if (env.TMUX) return false
  if (isEnvTruthy(flagEnv('MERCURY_FORCE_SYNC_OUTPUT', env))) return true
  if (SYNC_PROGRAMS.has(env.TERM_PROGRAM ?? '')) return true
  const term = env.TERM ?? ''
  const namedTerm = term.includes('kitty') || term === 'xterm-ghostty' || term.startsWith('foot') || term.includes('alacritty')
  const hostMarker = env.KITTY_WINDOW_ID || env.ZED_TERM || env.WT_SESSION
  return namedTerm || Boolean(hostMarker) || parseInt(env.VTE_VERSION ?? '', 10) >= 6800
}

export function isExtendedCsiSafe(env: Record<string, string | undefined> = hostEnv()): boolean {
  const version = Number.parseInt(env.VTE_VERSION ?? '', 10)
  return !Number.isFinite(version) || version >= 5300
}

export function isDecrqmProbeSafe(): boolean {
  return hostEnv().TERM_PROGRAM !== 'Apple_Terminal'
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
    if (isEnvTruthy(flagEnv('MERCURY_FORCE_SYNC_OUTPUT')) && !hostEnv().TMUX) {
      return { armed: true, why: 'forced on (MERCURY_FORCE_SYNC_OUTPUT)' }
    }
    return { armed: true, why: 'terminal identity sniff' }
  }
  if (hostEnv().TMUX) {
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
  xtversionName ??= name
}

export function isXtermJs(): boolean {
  if (hostEnv().TERM_PROGRAM === 'vscode') return true
  return xtversionName?.startsWith('xterm.js') ?? false
}

const EXTENDED_KEYS_TERMINALS = ['iTerm.app', 'kitty', 'WezTerm', 'ghostty', 'tmux', 'windows-terminal']

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
  if (extendedKeysSupported && extendedKeysProved) return
  extendedKeysSupported = true
  extendedKeysProved = true
  for (const listener of [...extendedKeysListeners]) listener()
}

export function subscribeExtendedKeysSupport(listener: () => void): () => void {
  extendedKeysListeners.add(listener)
  return () => {
    extendedKeysListeners.delete(listener)
  }
}


export type Progress = {
  state: 'completed' | 'error' | 'indeterminate' | 'running'
  percentage?: number
}

export function isProgressReportingAvailable(
  env: Record<string, string | undefined> = hostEnv(),
  tty: boolean = process.stdout.isTTY,
): boolean {
  const setting = getInitialSettings().activity?.progress
  if (setting !== undefined) return setting
  if (!tty) return false
  if (env.WT_SESSION || env.ConEmuANSI || env.ConEmuPID || env.ConEmuTask) return true
  const version = coerce(env.TERM_PROGRAM_VERSION)?.version
  if (version === undefined) return false
  if (env.TERM_PROGRAM === 'ghostty') return gte(version, '1.2.0')
  if (env.TERM_PROGRAM === 'iTerm.app') return gte(version, '3.6.6')
  return false
}


export function hasCursorUpViewportYankBug(): boolean {
  return isWindowsTerminalHost(hostEnv())
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


const ADDITIONAL_HYPERLINK_TERMINALS = [
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
  const env = options?.env ?? hostEnv()
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) return true
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) return true
  if (env['TERM']?.includes('kitty')) return true
  return false
}


const CURSOR_HOME_WINDOWS = csi(0, 'f')

export function isModernWindowsTerminal(
  env: Record<string, string | undefined> = hostEnv(),
  platform: string = process.platform,
): boolean {
  return isModernWindowsTerminalHost(env, platform)
}

export function getClearTerminalSequence(): string {
  if (isLegacyWindowsConsole(hostEnv())) {
    return ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + CURSOR_HOME
}
