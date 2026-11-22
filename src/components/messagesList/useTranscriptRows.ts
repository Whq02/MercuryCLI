import { useMemo, useRef } from 'react'
import type { Message as WireMessage, RenderableMessage } from '../../types/message.js'
import { getToolUseID } from '../../services/messages/lookups.js'
import { normalizeMessages } from '../../utils/messages/normalize.js'
import { isNotEmptyMessage } from '../../utils/messages/text.js'
import { deriveUUID } from '../../utils/messages/identity.js'
import { EMPTY_SYNTHETIC, EMPTY_ROWS, composeTranscript, reuseSettledRows, EMPTY_NORMALIZED, EMPTY_COMPOSITION } from './transcript.js'
import type { MessagesProps } from './shapes.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function useTranscriptRows(arg0: { fullscreen: boolean; inProgressToolUseIDs: MessagesProps['inProgressToolUseIDs']; isTranscriptMode: boolean; messages: MessagesProps['messages']; showAllInTranscript: Exclude<MessagesProps['showAllInTranscript'], undefined>; streamingToolUses: MessagesProps['streamingToolUses']; tailAnchor: MessagesProps['tailAnchor']; tools: MessagesProps['tools']; verbose: MessagesProps['verbose']; virtualised: boolean }): Unbuilt {
  return notBuilt('src/components/messagesList/useTranscriptRows.ts:10')
}
