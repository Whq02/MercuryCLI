// The composed keybinding provider: synchronous first-render load, hot
// reload, the warning notification, chord timing with its one-shot grace
// window, the active-context ref, and the global chord interceptor that
// registers its input listener BEFORE any child.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications } from '../context/notifications.js'
import type { InputEvent, Key } from '../ink/events/input-event.js'
import useInput from '../ink/hooks/use-input.js'
import { traceKeyResolved } from '../ink/root/frame-trace.js'
import { currentKeyCapture } from './keyCapture.js'
import { publishPendingChord } from './pendingChordMirror.js'
import {
  KeybindingProvider,
  type HandlerRegistry,
  type KeybindingContextValue,
} from './KeybindingContext.js'
import {
  initializeKeybindingWatcher,
  loadKeybindingsSyncWithWarnings,
  subscribeToKeybindingChanges,
  type KeybindingsLoadResult,
} from './loadUserBindings.js'
import { resolveKeyWithChordState, unboundConsumes } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

/** Raised from one second: a fresh session's paint or a glance at the
 *  screen routinely exceeds a second, and a silently cancelled prefix let
 *  the suffix key type into the composer. */
const CHORD_TIMEOUT_MS = 2000
/** One-shot: a key inside this window after the timeout still completes the
 *  expired chord (the two-key intent is unambiguous); a non-completing key
 *  is ordinary typing. Granted once per expiry, never renewed. */
const CHORD_TIMEOUT_GRACE_MS = 2000

const WARNING_NOTIFICATION_KEY = 'keybinding-warnings'
const WARNING_NOTIFICATION_TIMEOUT_MS = 60_000

type ExpiredChord = { pending: ParsedKeystroke[]; at: number }

type InterceptorProps = {
  bindings: ParsedBinding[]
  pendingChordRef: React.MutableRefObject<ParsedKeystroke[] | null>
  expiredChordRef: React.MutableRefObject<ExpiredChord | null>
  setPendingChord: KeybindingContextValue['setPendingChord']
  activeContextsRef: React.MutableRefObject<Set<KeybindingContextName>>
  handlerRegistryRef: React.MutableRefObject<HandlerRegistry>
}

/** Zero-render; its listener registers first so a chord's second key is
 *  recognised before the composer can insert it. */
function ChordInterceptor({
  bindings,
  pendingChordRef,
  expiredChordRef,
  setPendingChord,
  activeContextsRef,
  handlerRegistryRef,
}: InterceptorProps): null {
  useInput((input: string, key: Key, event: InputEvent) => {
    // 1. A surface reading keys rather than obeying them owns the keystroke.
    const capture = currentKeyCapture();
    if (capture) {
      capture(input, key);
      event.stopImmediatePropagation()
      return;
    }

    // 2. Wheel events never join chord machinery.
    if ((key.wheelUp || key.wheelDown) && pendingChordRef.current === null) return

    // 3. The vantage: every registered handler's context, every active
    //    context, and Global — wider than any per-component hook, so a
    //    prefix or an unbound verdict is seen wherever a mounted surface
    //    could own the completion.
    const contextSet = new Set<KeybindingContextName>()
    for (const registrations of handlerRegistryRef.current.values()) {
      for (const registration of registrations) contextSet.add(registration.context)
    }
    for (const context of activeContextsRef.current) contextSet.add(context)
    contextSet.add('Global')
    const contexts = [...contextSet]

    // 4. Grace resolution: an expired prefix is consumed one-shot.
    let effectivePending = pendingChordRef.current
    let viaGrace = false
    if (effectivePending === null && expiredChordRef.current !== null) {
      const expired = expiredChordRef.current
      expiredChordRef.current = null
      if (Date.now() - expired.at <= CHORD_TIMEOUT_GRACE_MS) {
        effectivePending = expired.pending
        viaGrace = true
      }
    }

    // 5. Resolve.
    const result = resolveKeyWithChordState(input, key, contexts, bindings, effectivePending)

    // 6. Trace the RESOLUTION — never the keystroke.
    traceKeyResolved(result.type === 'match' ? result.action : null, contexts)

    // 7. A late key that does not complete the timed-out chord is typing.
    if (viaGrace && result.type === 'chord_cancelled') return

    // 8. Dispatch.
    const wasInChord = effectivePending !== null && effectivePending.length > 0
    bb: switch (result.type) {
      case "chord_started": {
        setPendingChord(result.pending)
        event.stopImmediatePropagation()
        break bb
      }
      case "match": {
        setPendingChord(null)
        if (wasInChord) {
          const registrations = handlerRegistryRef.current.get(result.action)
          if (registrations) {
            for (const registration of registrations) {
              if (contexts.includes(registration.context)) {
                registration.handler()
                break
              }
            }
          }
          // The suffix belongs to the chord whatever happens next: a
          // completion with no mounted handler must still not type.
          event.stopImmediatePropagation();
        }
        break bb
      }
      case "chord_cancelled": {
        setPendingChord(null)
        event.stopImmediatePropagation()
        break bb
      }
      case "unbound": {
        setPendingChord(null)
        // The interceptor is what a printable meets first: consuming
        // unconditionally here would keep a null-unbound printable dead.
        if (wasInChord || unboundConsumes(input, key)) event.stopImmediatePropagation()
        break bb
      }
      case "none":
      default:
        break bb
    }
  })
  return null
}

export function KeybindingSetup({ children }: { children: React.ReactNode }): React.ReactNode {
  const [loadResult, setLoadResult] = useState<KeybindingsLoadResult>(() =>
    loadKeybindingsSyncWithWarnings(),
  )
  const [isReload, setIsReload] = useState(false)
  const { addNotification, removeNotification } = useNotifications()

  // Warning surfacing; the reload flag re-raises even unchanged warnings.
  useEffect(() => {
    const { warnings } = loadResult
    if (warnings.length === 0) {
      removeNotification(WARNING_NOTIFICATION_KEY)
      return
    }
    const errors = warnings.filter(w => w.severity === 'error').length
    const plainWarnings = warnings.length - errors
    const parts: string[] = []
    if (errors > 0) parts.push(`${errors} keybinding error${errors === 1 ? '' : 's'}`)
    if (plainWarnings > 0) {
      parts.push(`${plainWarnings} keybinding warning${plainWarnings === 1 ? '' : 's'}`)
    }
    addNotification({
      key: WARNING_NOTIFICATION_KEY,
      text: `${parts.join(' and ')} found — /health shows the details`,
      color: errors > 0 ? 'error' : 'warning',
      priority: errors > 0 ? 'immediate' : 'high',
      timeoutMs: WARNING_NOTIFICATION_TIMEOUT_MS,
    })
  }, [loadResult, isReload, addNotification, removeNotification])

  // Chord state lives twice on purpose: a ref for synchronous reads inside
  // input handlers, state to drive the pending-chord UI.
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = useState<ParsedKeystroke[] | null>(null)
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiredChordRef = useRef<ExpiredChord | null>(null)

  const setPendingChord = useCallback((pending: ParsedKeystroke[] | null) => {
    pendingChordRef.current = pending
    setPendingChordState(pending)
    // The process-visible mirror rides every transition (arm, resolve,
    // cancel — and the timeout below): a covered surface that paints
    // against the pending chord reads it there, never this provider.
    publishPendingChord(pending)
    if (chordTimeoutRef.current !== null) {
      clearTimeout(chordTimeoutRef.current)
      chordTimeoutRef.current = null
    }
    if (pending !== null) {
      chordTimeoutRef.current = setTimeout(() => {
        chordTimeoutRef.current = null
        const expired = pendingChordRef.current
        pendingChordRef.current = null
        setPendingChordState(null)
        publishPendingChord(null)
        // Stash the expired prefix for the one-shot grace window.
        if (expired !== null) expiredChordRef.current = { pending: expired, at: Date.now() }
      }, CHORD_TIMEOUT_MS)
    } else {
      // An explicit resolve/cancel supersedes any armed grace.
      expiredChordRef.current = null
    }
  }, [])

  // A ref, not state: input handlers must see registrations immediately.
  const activeContextsRef = useRef(new Set<KeybindingContextName>())
  const registerActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.add(context)
  }, [])
  const unregisterActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.delete(context)
  }, [])

  const handlerRegistryRef = useRef<HandlerRegistry>(new Map())

  useEffect(() => {
    void initializeKeybindingWatcher()
    // The initial load is synchronous, so any callback is a reload.
    const unsubscribe = subscribeToKeybindingChanges(result => {
      setLoadResult(result)
      setIsReload(true)
    })
    return () => {
      unsubscribe()
      if (chordTimeoutRef.current !== null) {
        clearTimeout(chordTimeoutRef.current)
        chordTimeoutRef.current = null
      }
    }
  }, [])

  return (
    <KeybindingProvider
      bindings={loadResult.bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      <ChordInterceptor
        bindings={loadResult.bindings}
        pendingChordRef={pendingChordRef}
        expiredChordRef={expiredChordRef}
        setPendingChord={setPendingChord}
        activeContextsRef={activeContextsRef}
        handlerRegistryRef={handlerRegistryRef}
      />
      {children}
    </KeybindingProvider>
  )
}
