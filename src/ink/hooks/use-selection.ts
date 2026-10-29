
import { useContext, useMemo, useSyncExternalStore } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import { type FocusMove, type SelectionState } from '../geometry/selection.js'
import type Ink from '../ink.js'

export type SelectionApi = {
  copySelection: () => string
  copySelectionNoClear: () => string
  copyText: (text: string) => void
  clearSelection: () => void
  hasSelection: () => boolean
  getState: () => SelectionState | null
  subscribe: (callback: () => void) => () => void
  moveFocus: (move: FocusMove) => void
  setSelectionBgColor: (color: string) => void
}

const noop = (): void => {}
const noopUnsubscribe = (): (() => void) => noop
const returnFalse = (): boolean => false
const returnEmpty = (): string => ''

function inertApi(): SelectionApi {
  return {
    copySelection: returnEmpty,
    copySelectionNoClear: returnEmpty,
    copyText: noop,
    clearSelection: noop,
    hasSelection: returnFalse,
    getState: () => null,
    subscribe: noopUnsubscribe,
    moveFocus: noop,
    setSelectionBgColor: noop,
  }
}

function instanceApi(ink: Ink): SelectionApi {
  return {
    copySelection: () => ink.copySelection(),
    copySelectionNoClear: () => ink.copySelectionNoClear(),
    copyText: text => ink.copyText(text),
    clearSelection: () => ink.clearTextSelection(),
    hasSelection: () => ink.hasTextSelection(),
    getState: () => ink.selection,
    subscribe: callback => ink.subscribeToSelectionChange(callback),
    moveFocus: move => ink.moveSelectionFocus(move),
    setSelectionBgColor: color => ink.setSelectionBgColor(color),
  }
}

export function useSelection(): SelectionApi {
  const ink = useContext(InkInstanceContext)
  return useMemo(() => (ink ? instanceApi(ink) : inertApi()), [ink])
}

export function useHasSelection(): boolean {
  const ink = useContext(InkInstanceContext)
  return useSyncExternalStore(
    ink ? ink.subscribeToSelectionChange : noopUnsubscribe,
    ink ? ink.hasTextSelection : returnFalse,
    ink ? ink.hasTextSelection : returnFalse,
  )
}
