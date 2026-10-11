import { useEffect, useRef } from 'react'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import type { SelectionApi } from '../ink/hooks/use-selection.js'
import { peekOwnInputSelection, subscribeOwnInputSelectionSettled } from '../utils/cockpit/inputSelectionBridge.js'
import { isCopyOnSelectEnabled } from '../utils/config.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import { getTheme } from '../utils/theme.js'

type Latch = { current: boolean }

const armed = (isActive: boolean): boolean => isActive && isFullscreenActive()

const worthAnnouncing = (text: string): string | null => (text.trim() === '' ? null : text)

function copySettledDrag(selection: SelectionApi, latch: Latch): string | null {
  const state = selection.getState()
  const settled = state !== null && selection.hasSelection() && !state.isDragging
  if (!settled) {
    latch.current = false
    return null
  }
  if (latch.current || !isCopyOnSelectEnabled()) return null
  const text = selection.copySelectionNoClear()
  latch.current = true
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
  const latestOnCopied = useRef(onCopied)
  latestOnCopied.current = onCopied
  const latch = useRef(false)
  const announce = (text: string | null): void => {
    if (text !== null) latestOnCopied.current?.(text)
  }

  useEffect(() => {
    if (!armed(isActive)) return
    return selection.subscribe(() => announce(copySettledDrag(selection, latch)))
  }, [selection, isActive])

  useEffect(() => {
    if (!armed(isActive)) return
    return subscribeOwnInputSelectionSettled(() => announce(copySettledOwnInput(selection)))
  }, [selection, isActive])
}

export function useSelectionBgColor(selection: SelectionApi): void {
  const [themeName] = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
