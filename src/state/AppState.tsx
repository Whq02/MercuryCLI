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

export function AppStateProvider({
  children,
  initialState,
}: {
  children: React.ReactNode
  initialState?: AppState
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
      },
    )
  }
  const store = storeRef.current

  useMount(() => {
    const context = store.getState().toolPermissionContext
    if (context.isBypassPermissionsModeAvailable && isSovereignDisabled()) {
      logForDebugging(
        'sovereign mode disabled by remotely-loaded policy settings that arrived before mount; correcting the permission context',
      )
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createSovereignDisabledContext(
          prev.toolPermissionContext,
        ),
      }))
    }
  })

  const applyChangedSourceRef = useRef((source: Parameters<typeof applySettingsChange>[0]) => {
    applySettingsChange(source, store.setState)
  })
  useClaim(() => {
    const unsubscribe = settingsChangeDetector.subscribe(source => {
      applyChangedSourceRef.current(source)
    })
    return unsubscribe
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
  const store = useContext(AppStoreContext)
  return useMemo(() => (store === null ? null : updater => store.setState(updater)), [store])
}

export function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected,
): Selected | undefined {
  const store = useContext(AppStoreContext)
  const subscribe = store ? store.subscribe : NOOP_SUBSCRIBE
  const getSnapshot = () => (store ? selector(store.getState()) : undefined)
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
