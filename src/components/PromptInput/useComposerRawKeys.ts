import type React from 'react'
import { useCallback } from 'react'
import { useInput } from '../../ink.js'
import type { Key } from '../../ink/events/input-event.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { Notification } from '../../context/notifications.js'
import { currentSurfaceRoute, isPriorGenerationInput } from '../../context/surfaceRoute.js'
import { useDoublePress } from '../../hooks/useDoublePress.js'
import { cancelVoiceCapture } from '../../services/voice/voiceSession.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { clearMainChat, enterCrewmateView, exitCrewmateView, setMainChat } from '../../state/crewmateViewHelpers.js'
import type { useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { crewClearedWords, crewClearRefusedWords, crewmateEscBackWords, crewmateInterruptedWords, crewmateInterruptRefusedWords } from '../../utils/cockpit/crewmateWords.js'
import { crewStateLabel } from '../../services/engine-connector/crewFacts.js'
import { clearCrewmate } from '../../state/crewLedger.js'
import { interruptCrewmate } from '../tasks/crewmateInterrupt.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { Message } from '../../types/message.js'
import {
  currentHelmRow,
  cycleHelmFocus,
  getHelmCursor,
  getHelmFocus,
  helmRailPastEntryBuffer,
  moveHelmCursor,
  requestHelmRowActivation,
  setHelmFocus,
} from '../../utils/cockpit/helmFocus.js'
import { popupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { flipToSession } from '../../services/engine-connector/sessionFlip.js'
import { getPlatform } from '../../utils/platform.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { SuggestionsState } from '../../hooks/useTypeahead.js'
import type { ComposerSubmit } from './useComposerSubmit.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const KEYSETUP_COMMAND = '/keysetup'

type ComposerRawKeysInput = Unbuilt

export function useComposerRawKeys(arg0: ComposerRawKeysInput): void {
  return notBuilt('src/components/PromptInput/useComposerRawKeys.ts:74')
}
