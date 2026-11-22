import type React from 'react'
import { useCallback } from 'react'
import * as pendingInput from '../../input-core/pending-input.js'
import { pressSendNow } from '../../input-core/sendNowChord.js'
import { focusedSendNowLive, sendFocusedWordsNow } from '../../services/engine-connector/sendNowLive.js'
import { splitWayOut, type Notification } from '../../context/notifications.js'
import type { PastedContent } from '../../utils/config.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { expandPastedTextRefs } from '../../history.js'
import { getImageFromClipboard } from '../../utils/imagePaste.js'
import { editPromptInEditor } from '../../utils/promptEditor.js'
import { cyclePermissionMode } from '../../utils/permissions/getNextPermissionMode.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { OverlaySurface } from './composerOverlay.js'
import type { ComposerAttachments } from './useComposerAttachments.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import { crewmateThinkingKeyWords } from '../../utils/cockpit/crewmateWords.js'
import { crewmateCommandReceipt, openCrewmateModelPickerFor } from './crewmateCommands.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ComposerKeybindingsInput = Unbuilt

type ComposerKeybindings = {
  performUndo: () => void
  crewmateFooterIndex: number
}

export function useComposerKeybindings(arg0: ComposerKeybindingsInput): ComposerKeybindings {
  return notBuilt('src/components/PromptInput/useComposerKeybindings.ts:66')
}
