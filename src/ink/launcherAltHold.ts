import { deleteFlagEnv, flagEnv } from '../substrate/flagRegistry.js'
import { noteModesImported, noteModeReleased } from './root/terminalModeLedger.js'

let heldPending = flagEnv('MERCURY_ALT_HELD') === '1'

if (heldPending) deleteFlagEnv('MERCURY_ALT_HELD')

const TRANSFERRED_MODES = ['alt-screen', 'alternate-scroll', 'cursor-hidden'] as const
if (heldPending) noteModesImported('launcher-splash', TRANSFERRED_MODES)

const heldAtBoot = heldPending

export function launcherHeldAtBoot(): boolean {
  return heldAtBoot
}

export function launcherAltHoldPending(): boolean {
  return heldPending
}

export function consumeLauncherAltHold(): boolean {
  const v = heldPending
  heldPending = false
  if (v) {
    for (const mode of TRANSFERRED_MODES) noteModeReleased('launcher-splash', mode)
  }
  return v
}

export function releaseLauncherAltHoldNow(): void {
  if (!heldPending) return
  heldPending = false
  const RESTORE = '\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h'
  try {
    if (process.stdout.isTTY) process.stdout.write(RESTORE)
    else if (process.stderr.isTTY) process.stderr.write(RESTORE)
  } catch {
  }
  for (const mode of TRANSFERRED_MODES) noteModeReleased('launcher-splash', mode)
}

if (heldPending) {
  process.on('exit', () => {
    releaseLauncherAltHoldNow()
  })
}
