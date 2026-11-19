import type React from 'react'
import type { SuggestionItem as Suggestion } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { Notification } from '../../context/notifications.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { InlineGhostText, PromptInputMode } from '../../types/textInputTypes.js'

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
  onModeChange: ((mode: PromptInputMode) => void) | undefined
  setInput: (value: string) => void
  setCursorOffset: (offset: number) => void
}): void {
  const state = appStateStore.getState()
  const promptSuggestion = state.promptSuggestion
  if (!promptSuggestion?.text) return
  markAccepted?.()
  const text = promptSuggestion.text
  const { getModeFromInput, getValueFromInput } =
    require('../../components/PromptInput/inputModes.js') as typeof import('../../components/PromptInput/inputModes.js')
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
  const viewingCrewmate = Boolean(state.viewingAgentTaskId)
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
