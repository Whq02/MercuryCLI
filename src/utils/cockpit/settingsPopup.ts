import type * as React from 'react'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'

export type SettingsPopupView = 'config' | 'usage' | 'status' | 'jev' | 'localsetup' | 'logins'

export type SettingsPopupGeometry = { width: number; inner: number; rowBudget: number; compact: boolean }

export const SETTINGS_POPUP_COMPACT_BELOW_ROWS = 8

export const SETTINGS_POPUP_COMPACT_HINT = 'esc closes'

export function settingsPopupCompact(fullBodyRows: number): boolean {
  return fullBodyRows < SETTINGS_POPUP_COMPACT_BELOW_ROWS
}

export function settingsPopupMarker(position: number, total: number): string {
  return total > 0 ? `${Math.max(1, Math.min(position, total))} of ${total}` : ''
}

export function settingsPopupWindow(cursor: number, offset: number, total: number, size: number): { cursor: number; offset: number } {
  const rows = Math.max(1, size)
  const at = Math.max(0, Math.min(cursor, total - 1))
  let top = offset
  if (at < top) top = at
  if (at >= top + rows) top = at - rows + 1
  top = Math.max(0, Math.min(top, Math.max(0, total - rows)))
  return { cursor: at, offset: top }
}

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
