import { useRef } from 'react'
import { useClaim, usePublish } from './effects.js'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import type { SelectionApi } from '../ink/hooks/use-selection.js'
import { peekOwnInputSelection, subscribeOwnInputSelectionSettled } from '../utils/cockpit/inputSelectionBridge.js'
import { isCopyOnSelectEnabled } from '../utils/config.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import { getTheme } from '../utils/theme.js'

type Latch = { current: boolean }

const armed = (isActive: boolean): boolean => isActive && isFullscreenActive()

const worthAnnouncing = (text: string): string | null => (text.trim() === '' ? null : text)

function copySettledScreen(selection: SelectionApi, latch: Latch): string | null {
  const state = selection.getState()
  if (state === null || !selection.hasSelection() || state.isDragging) {
    latch.current = false
    return null
  }
  if (latch.current) return null
  if (!isCopyOnSelectEnabled()) return null
  latch.current = true
  const text = selection.copySelectionNoClear()
  return worthAnnouncing(text)
}

function copySettledOwnInput(selection: SelectionApi): string | null {
  if (!isCopyOnSelectEnabled()) return null
  const own = peekOwnInputSelection()
  if (own === null) return null
  selection.copyText(own.text)
  return worthAnnouncing(own.text)
}

export function useCopyOnSelect(selection: SelectionApi, isActive: boolean, onCopied?: (text: string) => void): void {
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied
  const latchRef = useRef(false)
  const isArmed = armed(isActive)

  useClaim(() => {
    if (!isArmed) return
    const unsubscribeScreen = selection.subscribe(() => {
      const text = copySettledScreen(selection, latchRef)
      if (text !== null) onCopiedRef.current?.(text)
    })
    const unsubscribeOwn = subscribeOwnInputSelectionSettled(() => {
      const text = copySettledOwnInput(selection)
      if (text !== null) onCopiedRef.current?.(text)
    })
    return () => {
      unsubscribeScreen()
      unsubscribeOwn()
    }
  }, [selection, isArmed])
}

export function useSelectionBgColor(selection: SelectionApi): void {
  const [themeName] = useTheme()
  const selectionBg = getTheme(themeName).selectionBg
  usePublish(() => {
    selection.setSelectionBgColor(selectionBg)
  }, [selection, selectionBg])
}
