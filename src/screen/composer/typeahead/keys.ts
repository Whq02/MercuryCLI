import type React from 'react'
import type { SuggestionItem as Suggestion } from '../ComposerFooterSuggestions.js'
import type { Notification } from '../../notifications/notifications.js'
import { anyModalOverlayActive } from '../../overlays/overlayStack.js'
import { currentSurfaceRoute } from '../../routes/surfaceRoute.js'
import type { InputEvent, Key } from '../../renderer/events/input-event.js'
import { KeyboardEvent } from '../../renderer/events/keyboard-event.js'
import type { useOptionalKeybindingContext } from '../../keys/KeybindingContext.js'
import { getShortcutDisplay } from '../../keys/shortcutFormat.js'
import type { AppStateStore } from '../../app-state/AppStateStore.js'
import type { InlineGhostText, InputMode } from '../input-core/textInput.js'

const THINKING_HINT_KEY = 'thinking-toggle-hint'

export function acceptPromptSuggestionOf({
  appStateStore,
  markAccepted,
  onModeChange,
  setInput,
  setCursorOffset,
}: {
  appStateStore: AppStateStore
  markAccepted: (() => void) | undefined
  onModeChange: ((mode: InputMode) => void) | undefined
  setInput: (value: string) => void
  setCursorOffset: (offset: number) => void
}): void {
  const state = appStateStore.getState()
  const promptSuggestion = state.promptSuggestion
  if (!promptSuggestion?.text) return
  markAccepted?.()
  const text = promptSuggestion.text
  const { getModeFromInput, getValueFromInput } =
    require('../inputModes.js') as typeof import('../inputModes.js')
  const impliedMode = getModeFromInput(text)
  if (impliedMode !== 'prompt' && onModeChange) {
    onModeChange(impliedMode)
    const stripped = getValueFromInput(text)
    setInput(stripped)
    setCursorOffset(stripped.length)
  } else {
    setInput(text)
    setCursorOffset(text.length)
  }
}

export function handleTypeaheadKey(
  event: KeyboardEvent,
  {
    appStateStore,
    inputRef,
    suggestionsRef,
    inlineGhostText,
    cockpitActive,
    addNotification,
    keybindingContext,
    acceptPromptSuggestion,
    moveSelection,
    acceptSuggestion,
  }: {
    appStateStore: AppStateStore
    inputRef: React.MutableRefObject<string>
    suggestionsRef: React.MutableRefObject<Suggestion[]>
    inlineGhostText: InlineGhostText | undefined
    cockpitActive: boolean
    addNotification: (notification: Notification) => void
    keybindingContext: ReturnType<typeof useOptionalKeybindingContext>
    acceptPromptSuggestion: () => void
    moveSelection: (delta: number) => void
    acceptSuggestion: (atIndex: number | undefined, viaEnter: boolean) => void
  },
): void {
  const state = appStateStore.getState()
  const viewingCrewmate = Boolean(state.viewingCrewmateTaskId)
  const promptSuggestion = state.promptSuggestion

  if (
    event.key === 'right' &&
    !viewingCrewmate &&
    promptSuggestion?.text &&
    (promptSuggestion.shownAt ?? 0) > 0 &&
    inputRef.current === ''
  ) {
    acceptPromptSuggestion()
    event.stopImmediatePropagation()
    return
  }

  if (event.key === 'tab' && !event.shift) {
    if (
      suggestionsRef.current.length > 0 ||
      inlineGhostText !== undefined
    ) {
      return
    }
    if (
      !viewingCrewmate &&
      promptSuggestion?.text &&
      inputRef.current === ''
    ) {
      event.stopImmediatePropagation()
      acceptPromptSuggestion()
      return
    }
    if (inputRef.current.trim() === '') {
      if (cockpitActive) return
      event.stopImmediatePropagation()
      const chord = getShortcutDisplay('chat:thinkingToggle', 'Chat', 'meta+t')
      addNotification({
        key: THINKING_HINT_KEY,
        text: `${chord} toggles thinking`,
        priority: 'immediate',
        timeoutMs: 3000,
      })
    }
    return
  }

  if (suggestionsRef.current.length === 0) return

  if (event.ctrl && (event.key === 'n' || event.key === 'p')) {
    if (keybindingContext?.pendingChord) return
    event.stopImmediatePropagation()
    moveSelection(event.key === 'n' ? 1 : -1)
    return
  }

  if (event.key === 'return' && !event.shift && !event.meta) {
    event.stopImmediatePropagation()
    acceptSuggestion(undefined, true)
  }
}

export function typeaheadKeybindings({
  isModalOverlayActive,
  hasSuggestionsOrGhost,
  acceptSuggestion,
  cancelFileFetch,
  cancelChannelFetch,
  clearSuggestions,
  moveSelection,
  dismissedForInputRef,
  inputRef,
  suggestionsRef,
}: {
  isModalOverlayActive: boolean
  hasSuggestionsOrGhost: boolean
  acceptSuggestion: (atIndex: number | undefined, viaEnter: boolean) => void
  cancelFileFetch: () => void
  cancelChannelFetch: () => void
  clearSuggestions: () => void
  moveSelection: (delta: number) => void
  dismissedForInputRef: React.MutableRefObject<string | null>
  inputRef: React.MutableRefObject<string>
  suggestionsRef: React.MutableRefObject<Suggestion[]>
}) {
  return {
    'autocomplete:accept': () => {
      if (isModalOverlayActive) return false
      if (!hasSuggestionsOrGhost) return false
      acceptSuggestion(undefined, false)
    },
    'autocomplete:dismiss': () => {
      if (isModalOverlayActive) return false
      if (!hasSuggestionsOrGhost) return false
      cancelFileFetch()
      cancelChannelFetch()
      dismissedForInputRef.current = inputRef.current
      clearSuggestions()
    },
    'autocomplete:previous': () => {
      if (isModalOverlayActive) return false
      if (suggestionsRef.current.length === 0) return false
      moveSelection(-1)
    },
    'autocomplete:next': () => {
      if (isModalOverlayActive) return false
      if (suggestionsRef.current.length === 0) return false
      moveSelection(1)
    },
  }
}

export function routeTypeaheadInput(
  input_: string,
  key: Key,
  event: InputEvent,
  handleKeyboardEvent: (event: KeyboardEvent) => void,
): void {
  void input_
  void key
  if (currentSurfaceRoute().kind !== 'repl') return
  if (anyModalOverlayActive()) return
  const adapter = new KeyboardEvent(event.keypress)
  handleKeyboardEvent(adapter)
  if (adapter.didStopImmediatePropagation()) {
    event.stopImmediatePropagation()
  }
}
