import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useLayoutClaim } from '../hooks/effects.js'
import type { Key } from '../ink/events/input-event.js'
import { getPlatform } from '../utils/platform.js'
import { getBindingDisplayText, resolveKeyWithChordState, type ChordResolveResult } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type HandlerRegistry = Unbuilt

export type KeybindingContextValue = Unbuilt

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

export function useRegisterKeybindingContext(context: KeybindingContextName, isActive?: boolean): void {
  return notBuilt('src/keybindings/KeybindingContext.tsx:146')
}
