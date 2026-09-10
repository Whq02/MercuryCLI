import { flagEnv } from '../../substrate/flagRegistry.js'
import type { DesktopDriver, DesktopPermissions } from './driver.js'
import { fakeDesktopDriverFromEnvironment } from './fakeDesktopDriver.js'
import { resolveNativeDesktopDriver } from './nativeDriver.js'

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

function resolveFakeDriver(): DesktopDriverResolution {
  const fake = fakeDesktopDriverFromEnvironment()
  if (fake.state === 'ok') return { state: 'ok', driver: fake.driver, source: 'fake' }
  return { state: 'unavailable', note: fake.note, remedy: null }
}

function resolveNativeDriver(): DesktopDriverResolution {
  const native = resolveNativeDesktopDriver()
  if (native.state === 'ok') return { state: 'ok', driver: native.driver, source: native.driver.describe().source }
  return { state: 'unavailable', note: native.note, remedy: native.remedy }
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
        ? resolveFakeDriver()
        : resolveNativeDriver()
  if (answer.state === 'ok') resolved = answer
  return answer
}

let permissions: DesktopPermissions | null = null

export function rememberDesktopPermissions(answer: DesktopPermissions): void {
  permissions = answer
}

export function lastDesktopPermissions(): DesktopPermissions | null {
  return permissions
}

export function resetDesktopDriverForTest(): void {
  resolved = null
  permissions = null
}
