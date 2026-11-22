import type { Tools } from '../Tool.js'
import type {
  GroupedToolUseMessage,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../types/message.js'
import type { ToolUseBlock } from '../types/wire.js'

import { AGENT_TOOL_NAME } from '../constants/tools/agent.js'
import { notBuilt } from '../pi/holes.js'

type MessageWithoutProgress = Exclude<NormalizedMessage, { type: 'progress' }>

type GroupingResult = {
  messages: Array<MessageWithoutProgress | GroupedToolUseMessage>
}

const groupedToolNamesByTools = new WeakMap<object, Set<string>>()

function firstToolUse(message: MessageWithoutProgress): ToolUseBlock | null {
  if (message.type !== 'assistant') return null
  const block = message.message.content[0] as { type?: string } | undefined
  return block && block.type === 'tool_use' ? (block as ToolUseBlock) : null
}

export function applyGrouping(
  messages: MessageWithoutProgress[],
  tools: Tools,
  verbose?: boolean,
): GroupingResult {
  return notBuilt('src/utils/groupToolUses.ts:38')
}
