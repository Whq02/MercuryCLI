import * as React from 'react'
import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createStore } from './store.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import {
  getDefaultAppState,
  type AppState,
  type AppStateStore,
} from './AppStateStore.js'
import { onChangeAppState } from './onChangeAppState.js'
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from '../utils/permissions/permissionSetup.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { logForDebugging } from '../utils/debug.js'
import { MailboxProvider } from '../context/mailbox.js'

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

export const AppStoreContext = React.createContext<AppStateStore | null>(null)

const HasAppStateProviderContext = React.createContext<boolean>(false)

export function AppStateProvider({
  children,
  initialState,
  onChangeAppState: onChangeAppStateProp,
}: {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (change: { newState: AppState; oldState: AppState }) => void
}): React.ReactNode {
  const alreadyInsideProvider = useContext(HasAppStateProviderContext)
  if (alreadyInsideProvider) {
    throw new Error('AppStateProvider components cannot be nested')
  }

  const storeRef = useRef<AppStateStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createStore<AppState>(
      initialState ?? getDefaultAppState(),
      change => {
        fluxMark('appstate:set')
        onChangeAppState(change)
        onChangeAppStateProp?.(change)
      },
    )
  }
  const store = storeRef.current

  useEffect(() => {
    const context = store.getState().toolPermissionContext
    if (context.isBypassPermissionsModeAvailable && isBypassPermissionsModeDisabled()) {
      logForDebugging(
        'sovereign mode disabled by remotely-loaded policy settings that arrived before mount; correcting the permission context',
      )
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(
          prev.toolPermissionContext,
        ),
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyChangedSourceRef = useRef((source: Parameters<typeof applySettingsChange>[0]) => {
    applySettingsChange(source, store.setState)
  })
  useEffect(() => {
    const unsubscribe = settingsChangeDetector.subscribe(source => {
      applyChangedSourceRef.current(source)
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <HasAppStateProviderContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>{children}</MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateProviderContext.Provider>
  )
}

function useStoreOrThrow(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (store === null) {
    throw new ReferenceError(
      'useAppState/useSetAppState must be used inside an AppStateProvider',
    )
  }
  return store
}

export function useAppState<Selected>(selector: (state: AppState) => Selected): Selected {
  const store = useStoreOrThrow()
  const getSnapshot = (): Selected => selector(store.getState())
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
  const store = useContext(AppStoreContext)
  return useMemo(() => (store === null ? null : updater => store.setState(updater)), [store])
}

export function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected,
): Selected | undefined {
  const store = useContext(AppStoreContext)
  const getSnapshot = (): Selected | undefined =>
    store === null ? undefined : selector(store.getState())
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot, getSnapshot)
}
