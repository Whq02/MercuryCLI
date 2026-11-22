import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useLayoutClaim } from '../hooks/effects.js'
import type { Key } from '../ink/events/input-event.js'
import { getPlatform } from '../utils/platform.js'
import { getBindingDisplayText, resolveKeyWithChordState, type ChordResolveResult } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt } from '../pi/holes.js'

type Registration = { action: string; context: KeybindingContextName; handler: () => void }
export type HandlerRegistry = Map<string, Set<Registration>>

export type KeybindingContextValue = {
  activeContexts: Set<KeybindingContextName>
  bindings: ParsedBinding[]
  getDisplayText: (action: string, context: KeybindingContextName) => string | undefined
  invokeAction: (action: string) => boolean
  pendingChord: ParsedKeystroke[] | null
  registerActiveContext: (context: KeybindingContextName) => void
  registerHandler: (registration: Registration) => () => void
  resolve: (input: string, key: Key, contexts: KeybindingContextName[]) => ChordResolveResult
  setPendingChord: (chord: ParsedKeystroke[] | null) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
}

const KeybindingContext = createContext<KeybindingContextValue | null>(null)

type KeybindingProviderProps = Pick<KeybindingContextValue,
  'activeContexts' | 'bindings' | 'pendingChord' | 'registerActiveContext' | 'setPendingChord' | 'unregisterActiveContext'> & {
  children: React.ReactNode
  handlerRegistryRef: React.RefObject<HandlerRegistry>
  pendingChordRef: React.RefObject<ParsedKeystroke[] | null>
}

export function KeybindingProvider({ activeContexts, bindings, children, handlerRegistryRef, pendingChord, pendingChordRef, registerActiveContext, setPendingChord, unregisterActiveContext }: KeybindingProviderProps): React.ReactNode {
  const resolve = useCallback<KeybindingContextValue['resolve']>((input, key, contexts) =>
    resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current), [bindings, pendingChordRef])
  const getDisplayText = useCallback<KeybindingContextValue['getDisplayText']>((action, context) =>
    getBindingDisplayText(action, context, bindings, getPlatform()), [bindings])
  const registerHandler = useCallback((registration: Registration) => {
    const registry = handlerRegistryRef.current
    const { action } = registration
    const entries = registry.get(action) ?? new Set<Registration>()
    entries.add(registration)
    registry.set(action, entries)
    return () => {
      if (entries.delete(registration) && !entries.size) registry.delete(action)
    }
  }, [handlerRegistryRef])
  const invokeAction = useCallback((action: string) => {
    for (const entry of handlerRegistryRef.current.get(action) ?? []) {
      if (activeContexts.has(entry.context)) {
        entry.handler()
        return true
      }
    }
    return false
  }, [handlerRegistryRef, activeContexts])
  const value = useMemo(() => ({
    activeContexts, bindings, getDisplayText, invokeAction, pendingChord, registerActiveContext, registerHandler, resolve, setPendingChord, unregisterActiveContext,
  }), [activeContexts, bindings, getDisplayText, invokeAction, pendingChord, registerActiveContext, registerHandler, resolve, setPendingChord, unregisterActiveContext])
  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>
}

export function useKeybindingContext(): KeybindingContextValue {
  const value = useContext(KeybindingContext)
  if (!value) throw new Error('useKeybindingContext must be used inside a KeybindingProvider')
  return value
}

export function useOptionalKeybindingContext(): KeybindingContextValue | null {
  return useContext(KeybindingContext)
}

export function useRegisterKeybindingContext(context: KeybindingContextName, isActive?: boolean): void {
  return notBuilt('src/keybindings/KeybindingContext.tsx:146')
}
