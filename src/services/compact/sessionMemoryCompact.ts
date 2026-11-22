import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { createAttachmentMessage } from '../../utils/attachments/attachmentMessage.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  isCompactBoundaryMessage,
} from '../messages.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { fireHooks } from '../../utils/hooks/fire.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { tokenCountFromLastAPIResponse } from '../context/tokens.js'
import { extractDiscoveredToolNames } from '../messages/toolSearch.js'
import { isSessionMemoryEmpty, truncateSessionMemoryForCompact } from '../SessionMemory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../SessionMemory/sessionMemoryUtils.js'
import {
  annotateBoundaryWithPreservedSegment,
  annotateBoundaryWithWork,
  buildPostCompactMessages,
  type CompactionResult,
  createAsyncAgentAttachmentsIfNeeded,
  foldSizes,
} from './compact.js'
import type { ToolUseContext } from '../../Tool.js'
import { estimateContextTokens, estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type SessionMemoryCompactConfig = Unbuilt

const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = unbuilt('src/services/compact/sessionMemoryCompact.ts:44')

let config: SessionMemoryCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }

export function shouldUseSessionMemoryCompaction(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_SM_COMPACT'))
}


function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = (message as AssistantMessage).message.content
    return Array.isArray(content) && content.some(block => (block as { type?: string }).type === 'text')
  }
  if (message.type === 'user') {
    const content = (message as UserMessage).message.content
    if (typeof content === 'string') return content !== ''
    return Array.isArray(content) && content.some(block => (block as { type?: string }).type === 'text')
  }
  return false
}

function toolResultIdsOf(message: Message): string[] {
  if (message.type !== 'user') return []
  const content = (message as UserMessage).message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    const record = block as { type?: string; tool_use_id?: string }
    if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') ids.push(record.tool_use_id)
  }
  return ids
}

function toolUseIdsOf(message: Message): string[] {
  if (message.type !== 'assistant') return []
  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    const record = block as { type?: string; id?: string }
    if (record.type === 'tool_use' && typeof record.id === 'string') ids.push(record.id)
  }
  return ids
}

function adjustIndexToPreserveAPIInvariants(messages: Message[], startIndex: number): number {
  if (startIndex <= 0 || startIndex >= messages.length) return startIndex
  let index = startIndex

  const needed = new Set<string>()
  const present = new Set<string>()
  for (let i = index; i < messages.length; i++) {
    for (const id of toolResultIdsOf(messages[i] as Message)) needed.add(id)
    for (const id of toolUseIdsOf(messages[i] as Message)) present.add(id)
  }
  for (const id of present) needed.delete(id)
  let cursor = index - 1
  while (needed.size > 0 && cursor >= 0) {
    const message = messages[cursor] as Message
    const supplied = toolUseIdsOf(message).filter(id => needed.has(id))
    if (supplied.length > 0) {
      index = cursor
      for (const id of supplied) needed.delete(id)
    }
    cursor--
  }

  const keptIds = new Set<string>()
  for (let i = index; i < messages.length; i++) {
    const message = messages[i] as Message
    if (message.type === 'assistant') keptIds.add((message as AssistantMessage).message.id)
  }
  cursor = index - 1
  while (cursor >= 0) {
    const message = messages[cursor] as Message
    if (message.type === 'assistant' && keptIds.has((message as AssistantMessage).message.id)) {
      index = cursor
    }
    cursor--
  }
  return index
}


export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: string,
  autoCompactThreshold?: number,
  rosterContext?: Pick<ToolUseContext, 'getAppState' | 'agentId' | 'options'>,
  trigger?: 'auto' | 'manual',
): Promise<CompactionResult | null> {
  return notBuilt('src/services/compact/sessionMemoryCompact.ts:164')
}
