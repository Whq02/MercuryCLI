import { useContext, useMemo, useSyncExternalStore } from 'react'
import { ScreenInstanceContext } from '../elements/InkInstanceContext.js'
import { type FocusMove, type SelectionState } from '../geometry/selection.js'
import type ScreenInstance from '../screenInstance.js'

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

function instanceApi(instance: ScreenInstance): SelectionApi {
  return {
    copySelection: () => instance.copySelection(),
    copySelectionNoClear: () => instance.copySelectionNoClear(),
    copyText: text => instance.copyText(text),
    clearSelection: () => instance.clearTextSelection(),
    hasSelection: () => instance.hasTextSelection(),
    getState: () => instance.selection,
    subscribe: callback => instance.subscribeToSelectionChange(callback),
    moveFocus: move => instance.moveSelectionFocus(move),
    setSelectionBgColor: color => instance.setSelectionBgColor(color),
  }
}

export function useSelection(): SelectionApi {
  const instance = useContext(ScreenInstanceContext)
  return useMemo(() => (instance ? instanceApi(instance) : inertApi()), [instance])
}

export function useHasSelection(): boolean {
  const api = useSelection()
  return useSyncExternalStore(api.subscribe, api.hasSelection, api.hasSelection)
}
