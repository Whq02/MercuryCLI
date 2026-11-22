import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useLayoutClaim } from '../hooks/effects.js'
import type { Key } from '../ink/events/input-event.js'
import { getPlatform } from '../utils/platform.js'
import { getBindingDisplayText, resolveKeyWithChordState, type ChordResolveResult } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type HandlerRegistry = Unbuilt

export type KeybindingContextValue = Unbuilt

const KeybindingContext: Unbuilt = unbuilt('src/keybindings/KeybindingContext.tsx:32')

type KeybindingProviderProps = Unbuilt

export function KeybindingProvider(arg0: KeybindingProviderProps): React.ReactNode {
  return notBuilt('src/keybindings/KeybindingContext.tsx:46')
}

export function useKeybindingContext(): KeybindingContextValue {
  return notBuilt('src/keybindings/KeybindingContext.tsx:134')
}

export function useOptionalKeybindingContext(): KeybindingContextValue | null {
  return notBuilt('src/keybindings/KeybindingContext.tsx:142')
}

export function useRegisterKeybindingContext(context: KeybindingContextName, isActive = true): void {
  const value = useContext(KeybindingContext)
  const register = value?.registerActiveContext
  const unregister = value?.unregisterActiveContext
  useLayoutClaim(() => {
    if (!isActive || !register || !unregister) return
    register(context)
    return () => {
      unregister(context)
    }
  }, [context, isActive, register, unregister])
}
