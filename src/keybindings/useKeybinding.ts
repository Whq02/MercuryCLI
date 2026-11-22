import { useContext, useRef } from 'react'
import { useClaim } from '../hooks/effects.js'
import { currentSurfaceRoute, type SurfaceKind } from '../context/surfaceRoute.js'
import type { InputEvent, Key } from '../ink/events/input-event.js'
import useInput from '../ink/hooks/use-input.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import { unboundConsumes } from './resolver.js'
import { RouteSurfaceScopeContext } from './RouteSurfaceScope.js'
import type { KeybindingContextName } from './types.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type KeybindingHandlerResult = void | false | Promise<void>

export type UseKeybindingOptions = Unbuilt

function coveredFor(scope: SurfaceKind): boolean {
  const current = currentSurfaceRoute().kind
  return current !== 'repl' && current !== scope
}

function contextsFor(
  active: Set<KeybindingContextName>,
  context: KeybindingContextName,
): KeybindingContextName[] {
  const out: KeybindingContextName[] = []
  const seen = new Set<KeybindingContextName>()
  for (const name of [...active, context, 'Global']) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export function useKeybinding(
  action: string,
  handler: () => KeybindingHandlerResult,
  options?: UseKeybindingOptions,
): void {
  return notBuilt('src/keybindings/useKeybinding.ts:39')
}

export function useKeybindings(
  handlers: Record<string, () => KeybindingHandlerResult>,
  options?: UseKeybindingOptions,
): void {
  return notBuilt('src/keybindings/useKeybinding.ts:94')
}
