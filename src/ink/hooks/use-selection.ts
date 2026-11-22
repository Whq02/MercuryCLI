import { useContext, useMemo, useSyncExternalStore } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import { type FocusMove, type SelectionState } from '../geometry/selection.js'
import type Ink from '../ink.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type SelectionApi = Unbuilt

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
  return notBuilt('src/ink/hooks/use-selection.ts:38')
}

export function useSelection(): SelectionApi {
  const ink = useContext(InkInstanceContext)
  return useMemo(() => (ink ? instanceApi(ink) : inertApi()), [ink])
}

export function useHasSelection(): boolean {
  return notBuilt('src/ink/hooks/use-selection.ts:57')
}
