
import { useEffect, useRef } from 'react'
import type { SelectionApi } from '../ink/hooks/use-selection.js'
import {
  peekOwnInputSelection,
  subscribeOwnInputSelectionSettled,
} from '../utils/cockpit/inputSelectionBridge.js'
import { isCopyOnSelectEnabled } from '../utils/config.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import { getTheme } from '../utils/theme.js'
import { useTheme } from '../components/design-system/ThemeProvider.js'

export function useCopyOnSelect(
  selection: SelectionApi,
  isActive: boolean,
  onCopied?: (text: string) => void,
): void {
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied
  const copiedRef = useRef(false)

  useEffect(() => {
    if (!isActive) return
    if (!isFullscreenActive()) return
    return selection.subscribe(() => {
      const state = selection.getState()
      const has = selection.hasSelection()
      if (state === null || !has || state.isDragging) {
        copiedRef.current = false
        return
      }
      if (copiedRef.current) return
      if (!isCopyOnSelectEnabled()) return
      const text = selection.copySelectionNoClear()
      copiedRef.current = true
      if (text.trim() === '') return
      onCopiedRef.current?.(text)
    })
  }, [selection, isActive])

  useEffect(() => {
    if (!isActive) return
    if (!isFullscreenActive()) return
    return subscribeOwnInputSelectionSettled(() => {
      if (!isCopyOnSelectEnabled()) return
      const own = peekOwnInputSelection()
      if (own === null) return
      selection.copyText(own.text)
      if (own.text.trim() === '') return
      onCopiedRef.current?.(own.text)
    })
  }, [selection, isActive])
}

export function useSelectionBgColor(selection: SelectionApi): void {
  const [themeName] = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
