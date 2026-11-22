import { join } from 'node:path';
import React, { useRef, useState, useSyncExternalStore } from 'react';
import { type Command } from '../commands.js';
import { useLayoutChrome } from '../context/layoutChromeContext.js';
import { useCompactWorkControls } from '../components/tasks/CompactWorkSummary.js';
import { useAgentNeedsYou } from '../hooks/useAgentNeedsYou.js';
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js';
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js';
import { useNotifications } from '../context/notifications.js';
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../context/surfaceRoute.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useTurnEndPing } from '../hooks/useTurnEndPing.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTheme } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { streamingRevealSuppressed } from '../ink/session/capabilities.js';
import { useFocusedTailAnchor, useFocusedTranscript } from '../hooks/useFocusedTranscript.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { getFocusedSessionConnector, hasFocusedSession, conversationIdHere } from '../services/engine-connector/focusedConnector.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js';
import type { Tool } from '../Tool.js';
import { useChatScreenStore } from './chat/chatStore.js';
import { useChatAsks, useChatAsksCard } from './chat/useChatAsks.js';
import { useChatBootLines, useChatBootNotices, useChatBootStart, useChatBootTips, useChatCrashResume } from './chat/useChatBoot.js';
import { type ToolJSXState, useChatDialogPaints, useChatDialogs, useChatDialogsView } from './chat/useChatDialogs.js';
import { useChatDraft } from './chat/useChatDraft.js';
import { useChatScroll, useChatScrollFollow, useChatScrollPin } from './chat/useChatScroll.js';
import { useChatSearch } from './chat/useChatSearch.js';
import { useChatSelector, useChatSelectorView } from './chat/useChatSelector.js';
import { useChatConversation, useChatSession } from './chat/useChatSession.js';
import { useChatSeatClock, useChatStatusStrip, useChatTurnBoundary, useChatTurnEnd, useChatTurnSignals } from './chat/useChatStatus.js';
import { useChatReceipts, useChatSubmit, useChatSubmitTools } from './chat/useChatSubmit.js';
import { useChatTitle } from './chat/useChatTitle.js';
import { setCrashConversationLocator } from '../utils/crashReport.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { chatBottomSlot } from './chat/chatBottomSlot.js';
import { chatMessagesList, chatTranscriptBody } from './chat/chatMessagesList.js';
import { chatLegacyTree, chatTree } from './chat/chatTree.js';
import type { FocusedInputDialog } from './chat/focusedDialog.js';
import type { Screen as ScreenName } from './chat/screen.js';
import { getFocusedSeatLive, useChatFocusedSeat } from './chat/useChatFocusedSeat.js';
import { useChatTools } from './chat/useChatTools.js';
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type Screen = ScreenName;

export type Props = Unbuilt;


export function Chat(arg0: Props): React.ReactNode {
  return notBuilt('src/screens/Chat.tsx:94')
}
