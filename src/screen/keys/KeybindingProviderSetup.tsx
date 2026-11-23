import React, { useCallback, useRef, useState } from 'react'
import { useLoad, usePublish } from '../effects/effects.js'
import { useNotifications } from '../notifications/notifications.js'
import type { InputEvent, Key } from '../renderer/events/input-event.js'
import useInput from '../renderer/bindings/use-input.js'
import { traceKeyResolved } from '../renderer/root/frame-trace.js'
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
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

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

function ChordInterceptor({ bindings, pendingChordRef, expiredChordRef, setPendingChord, activeContextsRef, handlerRegistryRef }: InterceptorProps): null {
  useInput((input: string, key: Key, event: InputEvent) => {
    const capture = currentKeyCapture()
    if (capture) {
      capture(input, key)
      event.stopImmediatePropagation()
      return
    }
    let pending = pendingChordRef.current
    if ((key.wheelUp || key.wheelDown) && pending === null) return
    const contexts = new Set<KeybindingContextName>()
    for (const entries of handlerRegistryRef.current.values()) {
      for (const entry of entries) contexts.add(entry.context)
    }
    for (const name of activeContextsRef.current) contexts.add(name)
    contexts.add('Global')
    let byGrace = false
    if (pending === null && expiredChordRef.current !== null) {
      const expired = expiredChordRef.current
      expiredChordRef.current = null
      if (Date.now() - expired.at <= CHORD_TIMEOUT_GRACE_MS) {
        pending = expired.pending
        byGrace = true
      }
    }
    const names = [...contexts]
    const result = resolveKeyWithChordState(input, key, names, bindings, pending)
    traceKeyResolved(result.type === 'match' ? result.action : null, names)
    const inChord = pending !== null && pending.length > 0
    switch (result.type) {
      case 'chord_started':
        setPendingChord(result.pending)
        event.stopImmediatePropagation()
        break
      case 'match':
        setPendingChord(null)
        if (inChord) {
          for (const entry of handlerRegistryRef.current.get(result.action) ?? []) {
            if (!contexts.has(entry.context)) continue
            entry.handler()
            break
          }
          event.stopImmediatePropagation()
        }
        break
      case 'chord_cancelled':
        if (byGrace) return
        setPendingChord(null)
        event.stopImmediatePropagation()
        break
      case 'unbound':
        setPendingChord(null)
        if (inChord || unboundConsumes(input, key)) event.stopImmediatePropagation()
        break
    }
  })
  return null
}

export function KeybindingSetup({ children }: { children: React.ReactNode }): React.ReactNode {
  const [load, setLoad] = useState<KeybindingsLoadResult>(loadKeybindingsSyncWithWarnings)
  const [pendingChord, setPending] = useState<ParsedKeystroke[] | null>(null)
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null)
  const expiredChordRef = useRef<ExpiredChord | null>(null)
  const timer = useRef<ReturnType<typeof startTimeout> | null>(null)
  const activeContextsRef = useRef(new Set<KeybindingContextName>())
  const handlerRegistryRef = useRef<HandlerRegistry>(new Map())
  const registerActiveContext = useCallback((context: KeybindingContextName) => { activeContextsRef.current.add(context) }, [])
  const unregisterActiveContext = useCallback((context: KeybindingContextName) => { activeContextsRef.current.delete(context) }, [])
  const setPendingChord = useCallback((next: ParsedKeystroke[] | null) => {
    pendingChordRef.current = next
    setPending(next)
    publishPendingChord(next)
    if (timer.current !== null) {
      stopTimeout(timer.current)
      timer.current = null
    }
    if (next === null) expiredChordRef.current = null
    else {
      timer.current = startTimeout(() => {
        const pending = pendingChordRef.current
        pendingChordRef.current = null
        setPending(null)
        publishPendingChord(null)
        if (pending !== null) expiredChordRef.current = { pending, at: Date.now() }
        timer.current = null
      }, CHORD_TIMEOUT_MS)
    }
  }, [])
  useLoad(() => {
    void initializeKeybindingWatcher()
    const unsubscribe = subscribeToKeybindingChanges(setLoad)
    return () => {
      unsubscribe()
      if (timer.current !== null) stopTimeout(timer.current)
    }
  }, [])
  const { addNotification, removeNotification } = useNotifications()
  usePublish(() => {
    if (load.warnings.length === 0) {
      removeNotification(WARNING_NOTIFICATION_KEY)
      return
    }
    const errors = load.warnings.filter(w => w.severity === 'error').length
    const warnings = load.warnings.length - errors
    const parts: string[] = []
    if (errors) parts.push(`${errors} keybinding error${errors === 1 ? '' : 's'}`)
    if (warnings) parts.push(`${warnings} keybinding warning${warnings === 1 ? '' : 's'}`)
    addNotification({
      key: WARNING_NOTIFICATION_KEY, timeoutMs: WARNING_NOTIFICATION_TIMEOUT_MS,
      text: `${parts.join(' and ')} found — /health shows the details`,
      color: errors ? 'error' : 'warning', priority: errors ? 'immediate' : 'high',
    })
  }, [load, addNotification, removeNotification])
  return (
    <KeybindingProvider bindings={load.bindings} pendingChord={pendingChord} pendingChordRef={pendingChordRef} setPendingChord={setPendingChord} activeContexts={activeContextsRef.current} registerActiveContext={registerActiveContext} unregisterActiveContext={unregisterActiveContext} handlerRegistryRef={handlerRegistryRef}>
      <ChordInterceptor bindings={load.bindings} pendingChordRef={pendingChordRef} expiredChordRef={expiredChordRef} setPendingChord={setPendingChord} activeContextsRef={activeContextsRef} handlerRegistryRef={handlerRegistryRef} />
      {children}
    </KeybindingProvider>
  )
}
