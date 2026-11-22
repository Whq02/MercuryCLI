import React, { memo, useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { RenderableMessage } from '../types/message.js'
import { isFullscreenActive, isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import { getGlobalConfig } from '../utils/config.js'
import { getIsRemoteMode } from '../bootstrap/state.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useTabRing } from '../ink/terminalWrite.js'
import { type MessageActionsState, InVirtualListContext } from './messageActions.js'
import { setMessageCursor, useMessageCursor } from './messageCursorStore.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { LiveStreamingTail } from './LiveStreamingTail.js'
import { FoldStatusRow } from './FoldStatusRow.js'
import { VirtualMessageList } from './VirtualMessageList.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { useTranscriptRows } from './messagesList/useTranscriptRows.js'
import { useVisibleRows } from './messagesList/useVisibleRows.js'
import { useRowExpansion } from './messagesList/useRowExpansion.js'
import { useSearchFacets } from './messagesList/useSearchFacets.js'
import { messagesHeader } from './messagesList/header.js'
import { renderMessageRow } from './messagesList/row.js'
import type { MessagesProps } from './messagesList/shapes.js'
import { notBuilt } from '../pi/holes.js'
export { computeSliceStart, reuseSettledRows, isAssistantContinuationRow, composeTranscript } from './messagesList/transcript.js'

function MessagesInner(arg0: MessagesProps): React.ReactNode {
  return notBuilt('src/components/Messages.tsx:29')
}

function areMessagesPropsEqual(
  prev: MessagesProps,
  next: MessagesProps,
): boolean {
  return notBuilt('src/components/Messages.tsx:227')
}

export const Messages = memo(MessagesInner, areMessagesPropsEqual)

export default Messages
