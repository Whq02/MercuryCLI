import type { Tools } from '../../tools/kit/tool.js'
import type {
  GroupedToolUseMessage,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../../engine/message-shapes/message.js'
import type { ToolUseBlock } from '../../engine/message-shapes/wire.js'

import { AGENT_TOOL_NAME } from '../../tools/kit/names/agent.js'
import { isRecord } from '../../platform/primitives/isRecord.js'

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

function isToolUseMessage(message: MessageWithoutProgress): message is NormalizedAssistantMessage<ToolUseBlock> {
  return firstToolUse(message) !== null
}

export function applyGrouping(
  messages: MessageWithoutProgress[],
  tools: Tools,
  verbose?: boolean,
): GroupingResult {
  if (verbose) return { messages }
  let names = groupedToolNamesByTools.get(tools)
  if (!names) {
    names = new Set(tools.filter(tool => typeof tool.renderGroupedToolUse === 'function').map(tool => tool.name))
    groupedToolNamesByTools.set(tools, names)
  }
  const results = new Map<string, NormalizedUserMessage>()
  for (const row of messages) {
    if (row.type !== 'user') continue
    for (const block of row.message.content) {
      if (block.type === 'tool_result') results.set(block.tool_use_id, row)
    }
  }
  const groups = new Map<string, GroupedToolUseMessage['messages']>()
  for (const row of messages) {
    if (!isToolUseMessage(row)) continue
    const call = row.message.content[0]
    if (!names.has(call.name)) continue
    if (call.name === AGENT_TOOL_NAME) {
      const result = results.get(call.id)
      if (!result) continue
      const id = isRecord(result.toolUseResult) ? result.toolUseResult['agentId'] : undefined
      if (typeof id !== 'string' || !id || result.message.content.some(block => block.type === 'tool_result' && block.is_error)) continue
    }
    const key = JSON.stringify([row.message.id, call.name])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const replacements = new Map<NormalizedAssistantMessage, GroupedToolUseMessage | null>()
  const groupedIds = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]!
    const paired: NormalizedUserMessage[] = []
    for (const row of group) {
      const id = row.message.content[0].id
      groupedIds.add(id)
      const result = results.get(id)
      if (result) paired.push(result)
      replacements.set(row, null)
    }
    replacements.set(first, {
      type: 'grouped_tool_use', toolName: first.message.content[0].name, messages: group, results: paired,
      displayMessage: first, uuid: `grouped-${first.uuid}`, timestamp: first.timestamp, messageId: first.message.id,
    })
  }
  const output: GroupingResult['messages'] = []
  for (const row of messages) {
    if (row.type === 'assistant') {
      const replacement = replacements.get(row)
      if (replacement !== undefined) {
        if (replacement) {
          output.push(replacement)
          replacements.set(row, null)
        }
        continue
      }
    } else if (row.type === 'user') {
      const blocks = row.message.content.filter(block => block.type === 'tool_result')
      if (blocks.length && blocks.every(block => groupedIds.has(block.tool_use_id))) continue
    }
    output.push(row)
  }
  return { messages: output }
}
