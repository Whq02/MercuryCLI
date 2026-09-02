// The keybinding context: resolution, chord state, active contexts and the
// handler registry, exposed as a referentially STABLE value (the provider
// wraps the whole main tree — an unmemoised value re-renders every shortcut
// hint on every keystroke).

import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo } from 'react'
import type { Key } from '../ink/events/input-event.js'
import { getPlatform } from '../utils/platform.js'
import { getBindingDisplayText, resolveKeyWithChordState, type ChordResolveResult } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

export type KeybindingHandler = () => void

export type HandlerRegistration = {
  action: string
  context: KeybindingContextName
  handler: KeybindingHandler
}

/** Registrations grouped by action id. */
export type HandlerRegistry = Map<string, Set<HandlerRegistration>>

export type KeybindingContextValue = {
  resolve: (input: string, key: Key, activeContexts: KeybindingContextName[]) => ChordResolveResult
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  getDisplayText: (action: string, context: KeybindingContextName) => string | undefined
  bindings: ParsedBinding[]
  /** null when not in a chord. */
  pendingChord: ParsedKeystroke[] | null
  activeContexts: Set<KeybindingContextName>
  registerActiveContext: (context: KeybindingContextName) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
  /** Returns the unregister callback. */
  registerHandler: (registration: HandlerRegistration) => () => void
  /** Whether any handler ran. */
  invokeAction: (action: string) => boolean
}

const KeybindingContext = createContext<KeybindingContextValue | null>(null)

export type KeybindingProviderProps = {
  bindings: ParsedBinding[]
  pendingChordRef: React.MutableRefObject<ParsedKeystroke[] | null>
  pendingChord: ParsedKeystroke[] | null
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  activeContexts: Set<KeybindingContextName>
  registerActiveContext: (context: KeybindingContextName) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
  handlerRegistryRef: React.MutableRefObject<HandlerRegistry>
  children: React.ReactNode
}

export function KeybindingProvider({
  bindings,
  pendingChordRef,
  pendingChord,
  setPendingChord,
  activeContexts,
  registerActiveContext,
  unregisterActiveContext,
  handlerRegistryRef,
  children,
}: KeybindingProviderProps): React.ReactNode {
  const resolve = useCallback(
    (input: string, key: Key, contexts: KeybindingContextName[]) =>
      resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current),
    [bindings, pendingChordRef],
  )

  const getDisplayText = useCallback(
    (action: string, context: KeybindingContextName) =>
      getBindingDisplayText(action, context, bindings, getPlatform()),
    [bindings],
  )

  const registerHandler = useCallback(
    (registration: HandlerRegistration) => {
      const registry = handlerRegistryRef.current
      const { action } = registration
      let set = registry.get(action)
      if (!set) {
        set = new Set()
        registry.set(action, set)
      }
      set.add(registration)
      return () => {
        const current = registry.get(action)
        if (!current) return
        current.delete(registration)
        if (current.size === 0) registry.delete(action)
      }
    },
    [handlerRegistryRef],
  )

  const invokeAction = useCallback(
    (action: string): boolean => {
      const set = handlerRegistryRef.current.get(action)
      if (!set || set.size === 0) return false
      for (const registration of set) {
        if (activeContexts.has(registration.context)) {
          registration.handler()
          return true
        }
      }
      return false
    },
    [handlerRegistryRef, activeContexts],
  )

  const value = useMemo<KeybindingContextValue>(
    () => ({
      resolve,
      setPendingChord,
      getDisplayText,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    }),
    [
      resolve,
      setPendingChord,
      getDisplayText,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    ],
  )

  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>
}

/** Throws outside the provider. */
export function useKeybindingContext(): KeybindingContextValue {
  const value = useContext(KeybindingContext)
  if (!value) {
    throw new Error('useKeybindingContext must be used inside a KeybindingProvider')
  }
  return value
}

/** Null outside the provider — for components that may render before it. */
export function useOptionalKeybindingContext(): KeybindingContextValue | null {
  return useContext(KeybindingContext)
}

/** Register a context while mounted (layout phase): a registered context's
 *  bindings take precedence over Global. */
export function useRegisterKeybindingContext(context: KeybindingContextName, isActive = true): void {
  const value = useContext(KeybindingContext)
  const register = value?.registerActiveContext
  const unregister = value?.unregisterActiveContext
  useLayoutEffect(() => {
    if (!isActive || !register || !unregister) return
    register(context)
    return () => {
      unregister(context)
    }
  }, [context, isActive, register, unregister])
}
