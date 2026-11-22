import type React from 'react'
import { useCallback, useRef } from 'react'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { imageBlocksOf } from '../../services/engine-connector/daemonConnector.js'
import { getCommandName, type Command } from '../../commands.js'
import type { Notification } from '../../context/notifications.js'
import * as pendingInput from '../../input-core/pending-input.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { composerTargetTaskId } from '../../state/selectors.js'
import { CREWMATE_BETWEEN_TURNS_DETAIL, LEAD_ROW_NAME, crewmateCommandUnreachableWords, crewmateGlobalCommandWords, crewmateQueuedWords, crewmateRefusedWords, crewmateResumedWords, crewmateUnknownCommandWords, operatorLinePlate } from '../../utils/cockpit/crewmateWords.js'
import { queueCrewmateLine, refuseCrewmateLine } from '../tasks/crewmateQueue.js'
import { classifyAgentViewSubmission } from './promptIntent.js'
import { crewmateCommandReceipt, runCrewmateCommand } from './crewmateCommands.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { appendMessageToLocalAgent, isLocalAgentTask, queueOperatorMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { danglingReferences, expandPastedTextRefs, pasteUnavailableLine, resolvePastedContents } from '../../history.js'
import { handleSpeculationAccept } from '../../services/PromptSuggestion/speculation.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import type { SuggestionsState } from '../../hooks/useTypeahead.js'
import type { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import type { useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import { startMicrotask } from '../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const DOUBLED_SLASH = '//'
const CREWMATE_IMAGE_DETAIL = `a crewmate cannot read images; send the image to ${LEAD_ROW_NAME}, or describe it in words`

type ComposerSubmitOptions = { fromKeybinding?: boolean; isSlashPick?: boolean }

export type ComposerSubmit = (raw: string, options: ComposerSubmitOptions) => Promise<void>

type ComposerSubmitInput = Unbuilt

export function useComposerSubmit(arg0: ComposerSubmitInput): ComposerSubmit {
  return notBuilt('src/components/PromptInput/useComposerSubmit.ts:65')
}
