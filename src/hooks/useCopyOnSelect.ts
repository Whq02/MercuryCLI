import { useRef } from 'react'
import { useClaim, usePublish } from './effects.js'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import type { SelectionApi } from '../ink/hooks/use-selection.js'
import { peekOwnInputSelection, subscribeOwnInputSelectionSettled } from '../utils/cockpit/inputSelectionBridge.js'
import { isCopyOnSelectEnabled } from '../utils/config.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import { getTheme } from '../utils/theme.js'
import { notBuilt } from '../pi/holes.js'

type Latch = { current: boolean }

const armed = (isActive: boolean): boolean => isActive && isFullscreenActive()

const worthAnnouncing = (text: string): string | null => (text.trim() === '' ? null : text)

function copySettledOwnInput(selection: SelectionApi): string | null {
  if (!isCopyOnSelectEnabled()) return null
  const own = peekOwnInputSelection()
  if (own === null) return null
  selection.copyText(own.text)
  return worthAnnouncing(own.text)
}

export function useCopyOnSelect(selection: SelectionApi, isActive: boolean, onCopied?: (text: string) => void): void {
  return notBuilt('src/hooks/useCopyOnSelect.ts:37')
}

export function useSelectionBgColor(selection: SelectionApi): void {
  return notBuilt('src/hooks/useCopyOnSelect.ts:56')
}
