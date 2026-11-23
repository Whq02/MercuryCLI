import { useContext, useRef } from 'react'
import { useClaim } from '../effects/effects.js'
import { currentSurfaceRoute, type SurfaceKind } from '../routes/surfaceRoute.js'
import type { InputEvent, Key } from '../renderer/events/input-event.js'
import useInput from '../renderer/bindings/use-input.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import { unboundConsumes } from './resolver.js'
import { RouteSurfaceScopeContext } from './RouteSurfaceScope.js'
import type { KeybindingContextName } from './types.js'

export type KeybindingHandlerResult = void | false | Promise<void>

export type UseKeybindingOptions = {
  routeSafe?: boolean
  isActive?: boolean
  context?: KeybindingContextName
}

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
  useKeybindings({ [action]: handler }, options)
}

export function useKeybindings(
  handlers: Record<string, () => KeybindingHandlerResult>,
  options?: UseKeybindingOptions,
): void {
  const { context = 'Global', isActive = true, routeSafe = false } = options ?? {}
  const provider = useOptionalKeybindingContext()
  const scope = useContext(RouteSurfaceScopeContext)
  const latest = useRef(handlers)
  latest.current = handlers
  const registerHandler = provider?.registerHandler
  const namesKey = JSON.stringify(Object.keys(handlers).sort())
  useClaim(() => {
    if (!registerHandler || !isActive) return
    const releases = Object.keys(latest.current).map(action => registerHandler({
      action, context, handler: () => {
        if ((routeSafe || !coveredFor(scope)) && Object.hasOwn(latest.current, action)) latest.current[action]?.()
      },
    }))
    return () => { for (const release of releases) release() }
  }, [registerHandler, context, isActive, routeSafe, scope, namesKey])

  useInput((input: string, key: Key, event: InputEvent) => {
    if (!provider || (!routeSafe && coveredFor(scope))) return
    const result = provider.resolve(input, key, contextsFor(provider.activeContexts, context))
    switch (result.type) {
      case 'match': {
        provider.setPendingChord(null)
        const handler = Object.hasOwn(latest.current, result.action) ? latest.current[result.action] : undefined
        if (handler && handler() !== false) event.stopImmediatePropagation()
        break
      }
      case 'chord_started':
        provider.setPendingChord(result.pending)
        event.stopImmediatePropagation()
        break
      case 'chord_cancelled':
        provider.setPendingChord(null)
        break
      case 'unbound':
        provider.setPendingChord(null)
        if (unboundConsumes(input, key)) event.stopImmediatePropagation()
        break
    }
  }, { isActive: isActive && provider !== null })
}
