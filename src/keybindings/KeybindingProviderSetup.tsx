
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

const CHORD_TIMEOUT_MS = 2000
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

function ChordInterceptor({
  bindings,
  pendingChordRef,
  expiredChordRef,
  setPendingChord,
  activeContextsRef,
  handlerRegistryRef,
}: InterceptorProps): null {
  useInput((input: string, key: Key, event: InputEvent) => {
    const capture = currentKeyCapture();
    if (capture) {
      capture(input, key);
      event.stopImmediatePropagation()
      return;
    }

    if ((key.wheelUp || key.wheelDown) && pendingChordRef.current === null) return

    const contextSet = new Set<KeybindingContextName>()
    for (const registrations of handlerRegistryRef.current.values()) {
      for (const registration of registrations) contextSet.add(registration.context)
    }
    for (const context of activeContextsRef.current) contextSet.add(context)
    contextSet.add('Global')
    const contexts = [...contextSet]

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

    const result = resolveKeyWithChordState(input, key, contexts, bindings, effectivePending)

    traceKeyResolved(result.type === 'match' ? result.action : null, contexts)

    if (viaGrace && result.type === 'chord_cancelled') return

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

  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = useState<ParsedKeystroke[] | null>(null)
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiredChordRef = useRef<ExpiredChord | null>(null)

  const setPendingChord = useCallback((pending: ParsedKeystroke[] | null) => {
    pendingChordRef.current = pending
    setPendingChordState(pending)
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
        if (expired !== null) expiredChordRef.current = { pending: expired, at: Date.now() }
      }, CHORD_TIMEOUT_MS)
    } else {
      expiredChordRef.current = null
    }
  }, [])

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
