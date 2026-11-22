import type React from 'react'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { useLoad } from '../../hooks/effects.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { Notification } from '../../context/notifications.js'
import type { AppState } from '../../state/AppState.js'
import type { PastedContent } from '../../utils/config.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { bindLiveInputState, type LiveInputState } from '../../hooks/useTextInput.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { getGlobalConfig } from '../../utils/config.js'
import { parseReferences } from '../../history.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { expandTabs, stripControls } from './composerText.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const UNDO_BUFFER_SIZE = 50

type ComposerDraftInput = Unbuilt

type ComposerDraft = Unbuilt

export function useComposerDraft(arg0: ComposerDraftInput): ComposerDraft {
  return notBuilt('src/components/PromptInput/useComposerDraft.ts:55')
}
