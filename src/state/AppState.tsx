import * as React from 'react'
import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react'
import { useClaim, useMount } from '../hooks/effects.js'
import { createStore } from './store.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import {
  getDefaultAppState,
  type AppState,
  type AppStateStore,
} from './AppStateStore.js'
import { onChangeAppState } from './onChangeAppState.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
} from '../utils/permissions/permissionSetup.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { logForDebugging } from '../utils/debug.js'
import { MailboxProvider } from '../context/mailbox.js'
import { notBuilt } from '../pi/holes.js'

export {
  getDefaultAppState,
  IDLE_SPECULATION_STATE,
} from './AppStateStore.js'
export type {
  AppState,
  AppStateStore,
  CompletionBoundary,
  SpeculationResult,
  SpeculationState,
} from './AppStateStore.js'

export const AppStoreContext: React.Context<AppStateStore | null> = React.createContext<AppStateStore | null>(null)

const HasAppStateProviderContext: React.Context<boolean> = React.createContext<boolean>(false)

export function AppStateProvider(arg0: {
  children: React.ReactNode
  initialState?: AppState
}): React.ReactNode {
  return notBuilt('src/state/AppState.tsx:37')
}

function useStoreOrThrow(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState must be used inside an AppStateProvider')
  }
  return store
}

export function useAppState<Selected>(selector: (state: AppState) => Selected): Selected {
  const store = useStoreOrThrow()
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useSetAppState(): (updater: (prevState: AppState) => AppState) => void {
  const store = useStoreOrThrow()
  return useCallback(updater => store.setState(updater), [store])
}

export function useAppStateStore(): AppStateStore {
  return useStoreOrThrow()
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

export function useSetAppStateMaybe(): ((updater: (prevState: AppState) => AppState) => void) | null {
  return notBuilt('src/state/AppState.tsx:122')
}

export function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected,
): Selected | undefined {
  const store = useContext(AppStoreContext)
  const subscribe = store ? store.subscribe : NOOP_SUBSCRIBE
  const getSnapshot = () => (store ? selector(store.getState()) : undefined)
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
