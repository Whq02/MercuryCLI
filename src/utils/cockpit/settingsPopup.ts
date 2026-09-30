import type * as React from 'react'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'

export type SettingsPopupView = 'config' | 'usage' | 'status' | 'jev' | 'localsetup' | 'logins'

export type SettingsPopupGeometry = { width: number; inner: number; rowBudget: number }

export type SettingsPopupRequest = {
  view: SettingsPopupView
  width: number | ((hostColumns: number) => number)
  rows: number | null
  line: string
  hint: string
  bodyOwnsEscape?: boolean
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  body: (geometry: SettingsPopupGeometry) => React.ReactNode
}

let request: SettingsPopupRequest | null = null
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function openSettingsPopup(next: SettingsPopupRequest): void {
  request = next
  notify()
}

export function closeSettingsPopup(): void {
  if (request === null) return
  request = null
  notify()
}

export function settingsPopupRequest(): SettingsPopupRequest | null {
  return request
}

export function isSettingsPopupOpen(): boolean {
  return request !== null
}

export function settingsPopupVersion(): number {
  return version
}

export function subscribeSettingsPopup(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
