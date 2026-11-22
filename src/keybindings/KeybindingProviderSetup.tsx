import React, { useCallback, useRef, useState } from 'react'
import { useLoad, usePublish } from '../hooks/effects.js'
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
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

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

export function KeybindingSetup(arg0: { children: React.ReactNode }): React.ReactNode {
  return notBuilt('src/keybindings/KeybindingProviderSetup.tsx:126')
}
