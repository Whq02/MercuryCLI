import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useClaim, useLoad } from '../hooks/effects.js'
import { Box, Text } from '../ink.js'
import type {
  Message,
  PartialCompactDirection,
  UserMessage,
} from '../types/message.js'
import type { BranchManifest } from '../services/branches/branchManifest.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  CREWMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import { isSyntheticMessage, isTurnCutText } from '../services/messages.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { isAdvisorOrigin, isSaturnOrigin, wrappedNoticeBlocks } from '../utils/messages/noticeRows.js'
import { createBranchSession } from '../services/branches/branchManifest.js'
import { transcriptMessageIndex } from '../utils/sessionStorage/materialize.js'
import { getCwd } from '../utils/cwd.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import type {
  CheckpointFactsV1,
  RewindReceiptV1,
} from '../services/engine-connector/types.js'
import { messageText, previewOf } from './messageSelector/preview.js'
import { findMutatingShellToolUseIds, mutatingShellCountAfter, writtenElsewhereLine, type CodeStats } from './messageSelector/stats.js'
import { confirmOptionsOf, confirmView, CURRENT_PROMPT, pickView, summarizeView, UNDO_REWIND, type PickEntry } from './messageSelector/views.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export { statsBetween, writtenElsewhereLine } from './messageSelector/stats.js'


const subscribeFocusedCheckpoints = subscribeThroughFocused((connector, listener) =>
  connector.subscribeCheckpoints(listener),
)

function getFocusedCheckpoints(): CheckpointFactsV1 {
  return getFocusedSessionConnector().checkpointFacts()
}


const COMPLETE_TAG_MARKERS = [
  `<${LOCAL_COMMAND_STDOUT_TAG}>`,
  `<${LOCAL_COMMAND_STDERR_TAG}>`,
  `<${BASH_STDOUT_TAG}>`,
  `<${BASH_STDERR_TAG}>`,
  `<${TASK_NOTIFICATION_TAG}>`,
  `<${TICK_TAG}>`,
]
const CREWMATE_PREFIX: Unbuilt = unbuilt('src/components/MessageSelector.tsx:68')


function isTurnCutRow(message: UserMessage): boolean {
  return notBuilt('src/components/MessageSelector.tsx:71')
}

export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  return notBuilt('src/components/MessageSelector.tsx:77')
}

export function messagesAfterAreOnlySynthetic(
  messages: Message[],
  fromIndex: number,
): boolean {
  return notBuilt('src/components/MessageSelector.tsx:103')
}


let mountClaimed = false


export function MessageSelector(arg0: {
  messages: Message[]
  onPreRestore: () => void
  onRestore: (
    message: UserMessage | undefined,
    what: 'both' | 'conversation' | 'code',
    files?: { filePath?: string; undo?: boolean; userMessageId?: string },
  ) => Promise<RewindReceiptV1>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => void | Promise<void>
  onClose: () => void
  onBranchCreated?: (manifest: BranchManifest) => void
  providerOrigin?: string
  onViewOnly?: () => void
  onRerun?: (
    message: UserMessage,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  preselectedMessage?: UserMessage
}): React.ReactNode {
  return notBuilt('src/components/MessageSelector.tsx:138')
}

export default MessageSelector
