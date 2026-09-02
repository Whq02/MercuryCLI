// ============================================================================
//  src/state/AppState.tsx — the React binding: one store per provider
//  lifetime, selector/setter hooks over useSyncExternalStore, and the
//  mailbox/voice provider sandwich.
// ============================================================================
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

// Back-compat re-exports: importers that grew up on this module keep
// working without knowing the shape moved next door.
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

/** Nesting detection rides its own boolean context, not the store one. */
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

  // One store for the provider's lifetime.
  const storeRef = useRef<AppStateStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createStore<AppState>(
      initialState ?? getDefaultAppState(),
      change => {
        // The probe ring stamps every REAL app-state change (the store's
        // identity short-circuit already drops no-op updates) so the
        // region-invalidation reader can tell an app-state wake from a
        // feed's — off ⇒ a latched-boolean check, nothing else.
        fluxMark('appstate:set')
        onChangeAppState(change)
        onChangeAppStateProp?.(change)
      },
    )
  }
  const store = storeRef.current

  // Mount-time correction: remote settings may have arrived before mount.
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
    // The store is mount-stable; this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Settings-change subscription. The handler is an effect-event (a stable
  // identity reading fresh props/state through a ref) so the subscription
  // is not re-established on every render.
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

  // Mailbox inside the store context, all inside the "a provider exists"
  // boolean context.
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

/**
 * Subscribe to a slice; re-render only when the selected value changes by
 * identity. Call it multiple times for independent fields, and never
 * return a freshly constructed object from a selector (identity comparison
 * would always see a change).
 */
export function useAppState<Selected>(selector: (state: AppState) => Selected): Selected {
  const store = useStoreOrThrow()
  // The SAME getter serves client and server snapshots: no hydration
  // mismatch, no extra invocation.
  const getSnapshot = (): Selected => selector(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/**
 * The store's updater with a STABLE identity that never changes, so
 * components using only the setter never re-render on state change.
 */
export function useSetAppState(): (updater: (prevState: AppState) => AppState) => void {
  const store = useStoreOrThrow()
  return useCallback(updater => store.setState(updater), [store])
}

/** The store itself — for handing get/set to non-React code. */
export function useAppStateStore(): AppStateStore {
  return useStoreOrThrow()
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

/**
 * The "maybe outside a provider" setter: null when no provider is present
 * (the Boot face's bare mounts). A face-side sign-in bumps
 * authVersion through this exactly when a store EXISTS (a parked chat's
 * auth-dependent hooks re-read); with no store there is nothing to bump —
 * a later chat birth reads the fresh credentials from their owners.
 */
export function useSetAppStateMaybe(): ((updater: (prevState: AppState) => AppState) => void) | null {
  const store = useContext(AppStoreContext)
  return useMemo(() => (store === null ? null : updater => store.setState(updater)), [store])
}

/**
 * The "maybe outside a provider" selector: undefined when no provider is
 * present. The subscription primitive is still called unconditionally (a
 * no-op subscription in the absent case) to satisfy the rules of hooks.
 */
export function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected,
): Selected | undefined {
  const store = useContext(AppStoreContext)
  const getSnapshot = (): Selected | undefined =>
    store === null ? undefined : selector(store.getState())
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot, getSnapshot)
}
