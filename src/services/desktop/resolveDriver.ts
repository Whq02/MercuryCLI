import { flagEnv } from '../../substrate/flagRegistry.js'
import type { DesktopDriver } from './driver.js'

export const DESKTOP_DRIVER_CHOICES = ['native', 'fake', 'none'] as const
export type DesktopDriverChoice = (typeof DESKTOP_DRIVER_CHOICES)[number]

export type DesktopDriverSource = 'override' | 'vendored' | 'workspace' | 'fake'

export type DesktopDriverResolution =
  | { state: 'ok'; driver: DesktopDriver; source: DesktopDriverSource }
  | { state: 'unavailable'; note: string; remedy: string | null }

export const DESKTOP_DRIVER_OFF_NOTE = 'the desktop driver is switched off for this run (MERCURY_DESKTOP_DRIVER=none)'

export function desktopDriverChoice(): DesktopDriverChoice | { unknown: string } {
  const raw = (flagEnv('MERCURY_DESKTOP_DRIVER') ?? '').trim().toLowerCase()
  if (raw === '') return 'native'
  if ((DESKTOP_DRIVER_CHOICES as readonly string[]).includes(raw)) return raw as DesktopDriverChoice
  return { unknown: raw }
}

let resolved: DesktopDriverResolution | null = null

function resolveFakeDesktopDriver(): DesktopDriverResolution {
  return {
    state: 'unavailable',
    note: 'the fake desktop driver is not part of this build (MERCURY_DESKTOP_DRIVER=fake)',
    remedy: null,
  }
}

function resolveNativeDriver(): DesktopDriverResolution {
  return {
    state: 'unavailable',
    note: 'no desktop driver on this build — the native driver pack is not part of it',
    remedy: null,
  }
}

export function resolveDesktopDriver(): DesktopDriverResolution {
  if (resolved !== null) return resolved
  const choice = desktopDriverChoice()
  if (typeof choice !== 'string') {
    return {
      state: 'unavailable',
      note: `MERCURY_DESKTOP_DRIVER=${choice.unknown} names no desktop driver — native, fake or none`,
      remedy: null,
    }
  }
  const answer =
    choice === 'none'
      ? { state: 'unavailable' as const, note: DESKTOP_DRIVER_OFF_NOTE, remedy: null }
      : choice === 'fake'
        ? resolveFakeDesktopDriver()
        : resolveNativeDriver()
  if (answer.state === 'ok') resolved = answer
  return answer
}

export function resetDesktopDriverForTest(): void {
  resolved = null
}
