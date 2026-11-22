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
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

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

export const AppStoreContext: Unbuilt = unbuilt('src/state/AppState.tsx:33')

export function AppStateProvider(arg0: {
  children: React.ReactNode
  initialState?: AppState
}): React.ReactNode {
  return notBuilt('src/state/AppState.tsx:37')
}

function useStoreOrThrow(): AppStateStore {
  return notBuilt('src/state/AppState.tsx:95')
}

export function useAppState<Selected>(selector: (state: AppState) => Selected): Selected {
  return notBuilt('src/state/AppState.tsx:105')
}

export function useSetAppState(): (updater: (prevState: AppState) => AppState) => void {
  const store = useStoreOrThrow()
  return useCallback(updater => store.setState(updater), [store])
}

export function useAppStateStore(): AppStateStore {
  return notBuilt('src/state/AppState.tsx:116')
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

export function useSetAppStateMaybe(): ((updater: (prevState: AppState) => AppState) => void) | null {
  return notBuilt('src/state/AppState.tsx:122')
}

export function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected,
): Selected | undefined {
  return notBuilt('src/state/AppState.tsx:127')
}
