import { runTeardownSuite, type TeardownHost } from './teardown.js'
import { reassertModesBytes } from './screen-session.js'
import { passedOver } from '../../utils/passedOver.js'
import { terminalSupportsJobControl } from '../../utils/platform/terminal.js'
import { isOneOf } from '../../utils/isOneOf.js'

export const POSIX_STOP_SIGNALS = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU'] as const
export type StopSignal = (typeof POSIX_STOP_SIGNALS)[number]

export function stopSignalsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return terminalSupportsJobControl(platform)
}

export function isStopSignal(signal: string): signal is StopSignal {
  return isOneOf(POSIX_STOP_SIGNALS, signal)
}

export function stopIsForeground(signal: StopSignal): boolean {
  return signal === 'SIGTSTP'
}

type StopStdin = {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode(mode: boolean): unknown
}

type StopRestoreReceipt = {
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
    } catch (error) {
      passedOver(error)
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
