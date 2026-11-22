import React, {
  useCallback,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { useTypeahead } from '../../hooks/useTypeahead.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import type { AgentDefinition } from '../../types/agent.js'
import * as pendingInput from '../../input-core/pending-input.js'
import type { AppState } from '../../state/AppState.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { useCrewBanner } from './useCrewBanner.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useComposerRawKeys } from './useComposerRawKeys.js'
import { useComposerKeybindings } from './useComposerKeybindings.js'
import { useComposerSelectionRoad } from './useComposerSelection.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { fluxMark } from '../../utils/flux/fluxProbe.js'
import { useComposerHoldToTalk } from './useComposerVoice.js'
import { useComposerCompactFocus } from './useComposerCompactFocus.js'
import { useComposerHistory } from './useComposerHistory.js'
import { useComposerHelm } from './useComposerHelm.js'
import { useComposerHighlights } from './useComposerHighlights.js'
import { useComposerEffortNotice } from './useComposerEffortNotice.js'
import { composerSurface } from './composerSurface.js'
import { composerFrame, composerGeometry } from './composerFrame.js'
import { useComposerState } from './useComposerState.js'
import { useComposerWiring } from './useComposerWiring.js'
import { composerGates, composerInputBody, composerTextInputProps, composerView } from './composerView.js'
import type { CompactWorkControls, CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type PromptInputProps = Unbuilt

function PromptInputInner(props: PromptInputProps): React.ReactNode {
  return notBuilt('src/components/PromptInput/PromptInput.tsx:94')
}

const PromptInput = React.memo(PromptInputInner)
export default PromptInput
