import type React from 'react'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { Screen } from '../../screens/Chat.js'
import type { Message as WireMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { AgentDefinitionsResult } from '../../types/agent.js'
import type { StreamingThinking, StreamingToolUse } from '../../utils/messages/streaming.js'
import type { StreamingTailStore } from '../../utils/messages/streamingTailStore.js'
import type { MessageActionsNav } from '../messageActions.js'
import type { JumpHandle } from '../VirtualMessageList.js'
import type { DOMElement } from '../../ink.js'
import type { SearchPositionsState } from '../../ink/hooks/use-search-highlight.js'
import type { MatchPosition } from '../../ink/render-to-screen.js'
import type { useTranscriptRows } from './useTranscriptRows.js'
import type { useVisibleRows } from './useVisibleRows.js'
import type { useRowExpansion } from './useRowExpansion.js'

type UnseenDivider = { firstUnseenUuid: string; count: number }

export type MessagesProps = {
  messages: WireMessage[]
  tools: Tools
  verbose: boolean
  toolJSX: { jsx: React.ReactNode | null; shouldHidePromptInput: boolean } | null
  toolUseConfirmQueue: unknown[]
  inProgressToolUseIDs: Set<string>
  isMessageSelectorVisible: boolean
  conversationId: string
  screen: Screen
  streamingToolUses: StreamingToolUse[]
  isLoading: boolean
  commands?: Command[]
  showAllInTranscript?: boolean
  agentDefinitions?: AgentDefinitionsResult
  suppressLogo?: boolean
  suppressNotices?: boolean
  streamingThinking?: StreamingThinking | null
  hidePastReasoning?: boolean
  streamingTail?: StreamingTailStore | null
  streamingTextSuppressed?: boolean
  tailAnchor?: number
  unseenDivider?: UnseenDivider
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  jumpRef?: React.Ref<JumpHandle | null>
  onSearchMatchesChange?: (total: number, current: number) => void
  scanElement?: (el: DOMElement) => MatchPosition[]
  setPositions?: (state: SearchPositionsState | null) => void
  disableRenderCap?: boolean
  ownsCursor?: boolean
  cursorNavRef?: React.MutableRefObject<MessageActionsNav | null>
  renderRange?: readonly [number, number]
}
export type TranscriptRowsState = ReturnType<typeof useTranscriptRows>
export type VisibleRowsState = ReturnType<typeof useVisibleRows>
export type RowExpansionState = ReturnType<typeof useRowExpansion>
