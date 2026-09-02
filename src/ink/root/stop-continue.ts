import { runTeardownSuite, type TeardownHost } from './teardown.js'
import { reassertModesBytes } from './screen-session.js'

export const POSIX_STOP_SIGNALS = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as const
export type StopSignal = (typeof POSIX_STOP_SIGNALS)[number]

export function stopSignalsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function isStopSignal(signal: string): signal is StopSignal {
  return (POSIX_STOP_SIGNALS as readonly string[]).includes(signal)
}

export function stopIsForeground(signal: StopSignal): boolean {
  return signal === 'SIGTSTP'
}

export type StopStdin = {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode(mode: boolean): unknown
}

export type StopRestoreReceipt = {
  rawModeOff: boolean
}

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
    }
  }
  return { rawModeOff }
}

export function continueRearmBytes(opts: {
  extendedKeys: boolean
  altActive: boolean
  mouseTracking: boolean
}): string {
  return reassertModesBytes(opts)
}
