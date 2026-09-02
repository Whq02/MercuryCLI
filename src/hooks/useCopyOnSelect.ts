// Copy-on-select: a SETTLED mouse selection copies to the
// clipboard, deliberately WITHOUT clearing — the highlight is the receipt.
// Alternate screen only; the config opt-out is read AT EVENT TIME; the
// notification callback rides a ref so the effect never resubscribes
// (resubscribing resets the copied latch).

import { useEffect, useRef } from 'react'
import type { SelectionApi } from '../ink/hooks/use-selection.js'
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
        // A new drag (or a cleared selection) re-arms the latch, so a new
        // drag ending on the same range still copies.
        copiedRef.current = false
        return
      }
      if (copiedRef.current) return
      if (!isCopyOnSelectEnabled()) return
      // copySelectionNoClear performs the clipboard write (in-band OSC 52
      // included) — one copy per settled drag.
      const text = selection.copySelectionNoClear()
      copiedRef.current = true
      // Whitespace-only: no notification, but the latch stays set.
      if (text.trim() === '') return
      onCopiedRef.current?.(text)
    })
  }, [selection, isActive])
}

/** Pipes the theme's selection background into the renderer on mount and on
 *  every theme change, so the selection paints as a solid background. */
export function useSelectionBgColor(selection: SelectionApi): void {
  const [themeName] = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
