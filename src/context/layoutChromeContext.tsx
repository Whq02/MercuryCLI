import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import { layoutChromeLive, type ChromeMode } from '../hooks/useLayoutTier.js'
import { useRealTerminalSize } from '../hooks/useTerminalSize.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { settingsRevision } from '../utils/settings/snapshot.js'
import type { CompactFrameBudget } from '../components/mercury-ui/geometry.js'

export type LayoutChromeState = Readonly<{
  realColumns: number
  realRows: number
  fullscreen: boolean
  chrome: ChromeMode
  isCompact: boolean
}>

const LayoutChromeContext = createContext<LayoutChromeState | null>(null)
export const CompactFrameBudgetContext = createContext<CompactFrameBudget | null>(null)
export const CompactFooterNoticeContext = createContext<((active: boolean) => void) | null>(null)

export function LayoutChromeProvider({ children, fullscreen: fullscreenOverride }: { children: React.ReactNode; fullscreen?: boolean }): React.ReactNode {
  const { columns, rows } = useRealTerminalSize()
  useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)
  const fullscreen = fullscreenOverride ?? isFullscreenEnvEnabled()
  const { chrome, isCompact } = fullscreen ? layoutChromeLive(columns, rows) : { chrome: 'inline' as const, isCompact: false }
  const value = useMemo<LayoutChromeState>(() => ({
    realColumns: columns,
    realRows: rows,
    fullscreen,
    chrome,
    isCompact,
  }), [columns, rows, fullscreen, chrome, isCompact])
  return <LayoutChromeContext.Provider value={value}>{children}</LayoutChromeContext.Provider>
}

export function useLayoutChrome(): LayoutChromeState {
  const chrome = useContext(LayoutChromeContext)
  if (chrome === null) throw new Error('useLayoutChrome must be used within LayoutChromeProvider')
  return chrome
}
