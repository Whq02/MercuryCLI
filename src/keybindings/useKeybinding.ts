// The per-component binding hooks. A handler returning a synchronous
// `false` means "not consumed"; a promise is fire-and-forget. Bindings of a
// COVERED main REPL (another route surface owns the frame) are structurally
// inert — in the direct input path and in the registrations the interceptor
// invokes — unless they declare routeSafe. The covered check is read at
// EVENT time, never captured at render time.

import { useContext, useEffect, useRef } from 'react'
import { currentSurfaceRoute, type SurfaceKind } from '../context/surfaceRoute.js'
import type { InputEvent, Key } from '../ink/events/input-event.js'
import useInput from '../ink/hooks/use-input.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import { unboundConsumes } from './resolver.js'
import { RouteSurfaceScopeContext } from './RouteSurfaceScope.js'
import type { KeybindingContextName } from './types.js'

export type KeybindingHandlerResult = void | false | Promise<void>

export type UseKeybindingOptions = {
  context?: KeybindingContextName
  isActive?: boolean
  /** Keeps working while the REPL is covered (the surface-cycle chords). */
  routeSafe?: boolean
}

/** A binding is COVERED when another route surface owns the frame AND the
 *  binding is mounted outside that surface (RouteSurfaceScope): the parked
 *  root REPL's bindings stay inert under the Concourse (the seat fold's
 *  key-leak law), while a binding mounted INSIDE the covering surface — the
 *  standard consent card inline in the coordinator pane, its Select's
 *  ↑↓/↵/esc — is live, that surface being the frame's owner. Read at EVENT
 *  time, never captured at render time. */
function coveredFor(scope: SurfaceKind): boolean {
  const current = currentSurfaceRoute().kind
  return current !== 'repl' && current !== scope
}

/** Registered active contexts, then this hook's context, then Global —
 *  deduplicated preserving first occurrence (earlier wins). */
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
  options: UseKeybindingOptions = {},
): void {
  const { context = 'Global', isActive = true, routeSafe = false } = options
  const keybindings = useOptionalKeybindingContext()
  const scope = useContext(RouteSurfaceScopeContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const registerHandler = keybindings?.registerHandler
  useEffect(() => {
    if (!registerHandler || !isActive) return
    const guarded = () => {
      if (!routeSafe && coveredFor(scope)) return
      void handlerRef.current()
    }
    return registerHandler({ action, context, handler: guarded })
  }, [registerHandler, action, context, isActive, routeSafe, scope])

  useInput(
    (input: string, key: Key, event: InputEvent) => {
      if (!keybindings) return
      if (!routeSafe && coveredFor(scope)) return
      const result = keybindings.resolve(input, key, contextsFor(keybindings.activeContexts, context))
      switch (result.type) {
        case 'match': {
          keybindings.setPendingChord(null)
          if (result.action === action) {
            const outcome = handlerRef.current()
            if (outcome !== false) event.stopImmediatePropagation()
          }
          break
        }
        case 'chord_started':
          keybindings.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          keybindings.setPendingChord(null)
          break
        case 'unbound':
          keybindings.setPendingChord(null)
          if (unboundConsumes(input, key)) event.stopImmediatePropagation()
          break
        case 'none':
        default:
          break
      }
    },
    { isActive: isActive && keybindings !== null },
  )
}

export function useKeybindings(
  handlers: Record<string, () => KeybindingHandlerResult>,
  options: UseKeybindingOptions = {},
): void {
  const { context = 'Global', isActive = true, routeSafe = false } = options
  const keybindings = useOptionalKeybindingContext()
  const scope = useContext(RouteSurfaceScopeContext)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const actionKey = Object.keys(handlers).sort().join(' ')

  const registerHandler = keybindings?.registerHandler
  useEffect(() => {
    if (!registerHandler || !isActive) return
    const unregisters = Object.keys(handlersRef.current).map(action =>
      registerHandler({
        action,
        context,
        handler: () => {
          if (!routeSafe && coveredFor(scope)) return
          void handlersRef.current[action]?.()
        },
      }),
    )
    return () => {
      for (const unregister of unregisters) unregister()
    }
  }, [registerHandler, actionKey, context, isActive, routeSafe, scope])

  useInput(
    (input: string, key: Key, event: InputEvent) => {
      if (!keybindings) return
      if (!routeSafe && coveredFor(scope)) return
      const result = keybindings.resolve(input, key, contextsFor(keybindings.activeContexts, context))
      switch (result.type) {
        case 'match': {
          keybindings.setPendingChord(null)
          const owned = handlersRef.current[result.action]
          if (owned) {
            const outcome = owned()
            if (outcome !== false) event.stopImmediatePropagation()
          }
          break
        }
        case 'chord_started':
          keybindings.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          keybindings.setPendingChord(null)
          break
        case 'unbound':
          keybindings.setPendingChord(null)
          if (unboundConsumes(input, key)) event.stopImmediatePropagation()
          break
        case 'none':
        default:
          break
      }
    },
    { isActive: isActive && keybindings !== null },
  )
}
