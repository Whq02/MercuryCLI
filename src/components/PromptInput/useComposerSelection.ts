import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { DOMElement } from '../../ink/dom.js'
import { nodeCache, type CachedLayout } from '../../ink/node-cache.js'
import { useSelection } from '../../ink/hooks/use-selection.js'
import type { TextGesture } from '../../ink/events/text-gesture.js'
import { Cursor } from '../../utils/Cursor.js'
import * as pendingInput from '../../input-core/pending-input.js'
import {
  noteOwnInputSelectionChanged,
  noteOwnInputSelectionSettled,
  registerInputSelectionOwner,
} from '../../utils/cockpit/inputSelectionBridge.js'
import { submitTrace } from '../../utils/submitTrace.js'
import { isVimModeEnabled } from './utils.js'

type OwnSelection = { start: number; end: number; of: string }

export type ComposerSelectionState = {
  inputSelectionRangeRef: React.MutableRefObject<() => { start: number; end: number } | null>
  inputBoxRef: React.MutableRefObject<DOMElement | null>
  selectionApi: ReturnType<typeof useSelection>
  selectionGestureRectRef: React.MutableRefObject<CachedLayout | null>
  gestureAnchorRef: React.MutableRefObject<{ start: number; end: number; col: number; row: number; moved: boolean } | null>
  ownSelectionOf: (text: string) => { start: number; end: number } | null
  setOwnSelection: (next: OwnSelection | null) => void
  clearOwnSelection: () => void
}

export function useComposerSelectionState(): ComposerSelectionState {
  const inputSelectionRangeRef = useRef<() => { start: number; end: number } | null>(
    () => null,
  )
  const inputBoxRef = useRef<DOMElement | null>(null)
  const selectionApi = useSelection()
  const selectionGestureRectRef = useRef<CachedLayout | null>(null)
  const [, setOwnSelectionState] = useState<{ start: number; end: number; of: string } | null>(null)
  const ownSelectionRef = useRef<{ start: number; end: number; of: string } | null>(null)
  const gestureAnchorRef = useRef<{ start: number; end: number; col: number; row: number; moved: boolean } | null>(
    null,
  )
  const ownSelectionOf = (text: string): { start: number; end: number } | null => {
    const own = ownSelectionRef.current
    if (own === null || own.of !== text || own.start >= own.end) return null
    return { start: own.start, end: own.end }
  }
  const setOwnSelection = (next: { start: number; end: number; of: string } | null): void => {
    const had = ownSelectionRef.current !== null
    ownSelectionRef.current = next
    setOwnSelectionState(next)
    if (had || next !== null) noteOwnInputSelectionChanged()
  }
  const clearOwnSelection = (): void => {
    gestureAnchorRef.current = null
    if (ownSelectionRef.current === null) return
    setOwnSelection(null)
  }
  useEffect(
    () =>
      selectionApi.subscribe(() => {
        const state = selectionApi.getState()
        if (!state?.anchor) {
          selectionGestureRectRef.current = null
          return
        }
        clearOwnSelection()
        if (state.focus !== null && selectionGestureRectRef.current !== null) return
        const box = inputBoxRef.current
        selectionGestureRectRef.current = (box ? nodeCache.get(box) : undefined) ?? null
      }),
    [selectionApi],
  )

  return { inputSelectionRangeRef, inputBoxRef, selectionApi, selectionGestureRectRef, gestureAnchorRef, ownSelectionOf, setOwnSelection, clearOwnSelection }
}

export type ComposerSelectionRoadInput = {
  input: string
  cursorOffset: number
  textColumns: number
  maxVisibleLines: number | undefined
  composerViewportStartRef: React.MutableRefObject<number | undefined>
  isSearchingHistory: boolean
  setCursorOffset: (offset: number) => void
}

export type ComposerSelectionRoad = {
  ownSelection: { start: number; end: number } | null
  handleInputBoxClick: (event: { localCol: number; localRow: number }) => void
  handleInputTextGesture: (gesture: TextGesture) => boolean
}

export function useComposerSelectionRoad(
  {
    inputSelectionRangeRef,
    inputBoxRef,
    selectionApi,
    selectionGestureRectRef,
    gestureAnchorRef,
    ownSelectionOf,
    setOwnSelection,
    clearOwnSelection,
  }: ComposerSelectionState,
  { input, cursorOffset, textColumns, maxVisibleLines, composerViewportStartRef, isSearchingHistory, setCursorOffset }: ComposerSelectionRoadInput,
): ComposerSelectionRoad {
  const cellSpanAt =(localCol: number, localRow: number): { start: number; end: number } => {
    const cursor = Cursor.fromText(input, textColumns, cursorOffset)
    const viewportStart =
      composerViewportStartRef.current ?? cursor.getViewportStartLine(maxVisibleLines)
    const line = localRow + viewportStart
    const doc = cursor.measuredText
    const lineEnd = doc.getLineEndOffset(line)
    const start = Math.min(doc.getOffsetFromPosition({ line, column: localCol }), lineEnd)
    return { start, end: start < lineEnd ? doc.nextOffset(start) : start }
  }
  const offsetAtCell = (localCol: number, localRow: number): number => cellSpanAt(localCol, localRow).start
  const mapSelectionToInputRange = (): { start: number; end: number } | null => {
    if (isSearchingHistory) return null
    const state = selectionApi.getState()
    if (!state || !state.anchor || !state.focus) return null
    const box = inputBoxRef.current
    const rect = selectionGestureRectRef.current ?? (box ? nodeCache.get(box) : undefined)
    const trace = (why: string, start = -1, end = -1): void =>
      submitTrace('input-selection', '', {
        why,
        rx: rect?.x ?? -1, ry: rect?.y ?? -1, rw: rect?.width ?? -1, rh: rect?.height ?? -1,
        ac: state.anchor!.col, ar: state.anchor!.row, fc: state.focus!.col, fr: state.focus!.row,
        start, end, len: input.length,
      })
    if (!box) {
      trace('no-box')
      return null
    }
    if (!rect) {
      trace('no-rect')
      return null
    }
    const inside = (p: { col: number; row: number }): boolean =>
      p.col >= rect.x &&
      p.col < rect.x + rect.width &&
      p.row >= rect.y &&
      p.row < rect.y + rect.height
    if (!inside(state.anchor) || !inside(state.focus)) {
      trace('outside')
      return null
    }
    const [first, last] =
      state.anchor.row < state.focus.row ||
      (state.anchor.row === state.focus.row && state.anchor.col <= state.focus.col)
        ? [state.anchor, state.focus]
        : [state.focus, state.anchor]
    const start = offsetAtCell(first.col - rect.x, first.row - rect.y)
    const end = Math.min(
      input.length,
      offsetAtCell(last.col - rect.x, last.row - rect.y) + 1,
    )
    trace(start >= end ? 'degenerate' : 'ok', start, end)
    if (start >= end) return null
    return { start, end }
  }
  inputSelectionRangeRef.current =() => ownSelectionOf(pendingInput.text()) ?? mapSelectionToInputRange()
  useEffect(
    () =>
      registerInputSelectionOwner({
        range: () => inputSelectionRangeRef.current(),
        own: () => {
          const text = pendingInput.text()
          const range = ownSelectionOf(text)
          return range === null ? null : { ...range, text: text.slice(range.start, range.end) }
        },
        clear: clearOwnSelection,
      }),
    [],
  )
  const ownSelection = ownSelectionOf(input)
  const ownSelected = ownSelection !== null
  useEffect(() => {
    noteOwnInputSelectionChanged()
  }, [ownSelected])
  const handleInputBoxClick = (event: { localCol: number; localRow: number }): void => {
    if (isSearchingHistory || input === '') return
    setCursorOffset(
      Math.max(0, Math.min(input.length, offsetAtCell(event.localCol, event.localRow))),
    )
  }
  const handleInputTextGesture =(gesture: TextGesture): boolean => {
    if (isSearchingHistory || isVimModeEnabled() || input === '') return false
    if (gesture.kind === 'press') {
      if (gesture.clickCount >= 2) {
        gestureAnchorRef.current = null
        setOwnSelection({ start: 0, end: input.length, of: input })
        setCursorOffset(input.length)
        return true
      }
      const cell = cellSpanAt(gesture.localCol, gesture.localRow)
      gestureAnchorRef.current = { ...cell, col: gesture.localCol, row: gesture.localRow, moved: false }
      setOwnSelection(null)
      setCursorOffset(cell.start)
      return true
    }
    if (gesture.kind === 'drag') {
      const anchor = gestureAnchorRef.current
      if (anchor === null) return true
      if (!anchor.moved) {
        if (gesture.localCol === anchor.col && gesture.localRow === anchor.row) return true
        anchor.moved = true
      }
      const cell = cellSpanAt(gesture.localCol, gesture.localRow)
      const forward = cell.start >= anchor.start
      const start = forward ? anchor.start : cell.start
      const end = forward ? Math.max(cell.end, anchor.end) : anchor.end
      setOwnSelection(start < end ? { start, end, of: input } : null)
      setCursorOffset(forward ? end : start)
      return true
    }
    gestureAnchorRef.current = null
    if (ownSelectionOf(input) !== null) noteOwnInputSelectionSettled()
    return true
  }


  return { ownSelection, handleInputBoxClick, handleInputTextGesture }
}
