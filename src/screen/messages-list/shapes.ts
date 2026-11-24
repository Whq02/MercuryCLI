import type React from 'react'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import type { Screen } from '../chat/Chat.js'
import type { Message as WireMessage } from '../../engine/message-shapes/message.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { Command } from '../../commands/catalogue/commands.js'
import type { AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import type { StreamingThinking, StreamingToolUse } from './streamToScreen.js'
import type { StreamingTailStore } from '../../engine/message-shapes/streamingTailStore.js'
import type { MessageActionsNav } from '../messages/messageActions.js'
import type { JumpHandle } from '../virtual-message-list/VirtualMessageList.js'
import type { DOMElement } from '../themedRenderer.js'
import type { SearchPositionsState } from '../renderer/bindings/use-search-highlight.js'
import type { MatchPosition } from '../renderer/matchPositions.js'
import type { useTranscriptRows } from './useTranscriptRows.js'
import type { useVisibleRows } from './useVisibleRows.js'
import type { useRowExpansion } from './useRowExpansion.js'

type UnseenDivider = { firstUnseenUuid: string; count: number }

export type MessagesProps = {
  messages: WireMessage[]
  tools: Tools
  verbose: boolean
  toolJSX: { jsx: React.ReactNode | null; shouldHideComposer: boolean } | null
  toolUseConfirmQueue: unknown[]
  inProgressToolUseIDs: Set<string>
  isRewindPickerVisible: boolean
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
