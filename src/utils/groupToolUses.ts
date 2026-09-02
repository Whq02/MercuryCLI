import type { Tools } from '../Tool.js'
import type {
  GroupedToolUseMessage,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../types/message.js'
import type { ToolUseBlock } from '../types/wire.js'


export type MessageWithoutProgress = Exclude<NormalizedMessage, { type: 'progress' }>

export type GroupingResult = {
  messages: Array<MessageWithoutProgress | GroupedToolUseMessage>
}

const groupedToolNamesByTools = new WeakMap<object, Set<string>>()

function groupedToolNames(tools: Tools): Set<string> {
  const cached = groupedToolNamesByTools.get(tools as object)
  if (cached) return cached
  const names = new Set<string>()
  for (const tool of tools) {
    const renderer = (tool as { renderGroupedToolUse?: unknown }).renderGroupedToolUse
    if (typeof renderer === 'function') names.add(tool.name)
  }
  groupedToolNamesByTools.set(tools as object, names)
  return names
}

function firstToolUse(message: MessageWithoutProgress): ToolUseBlock | null {
  if (message.type !== 'assistant') return null
  const block = message.message.content[0] as { type?: string } | undefined
  return block && block.type === 'tool_use' ? (block as ToolUseBlock) : null
}

export function applyGrouping(
  messages: MessageWithoutProgress[],
  tools: Tools,
  verbose: boolean = false,
): GroupingResult {
  if (verbose) return { messages }
  const groupable = groupedToolNames(tools)

  const groups = new Map<string, NormalizedAssistantMessage<ToolUseBlock>[]>()
  const groupKeyByMessage = new Map<MessageWithoutProgress, string>()
  for (const message of messages) {
    const use = firstToolUse(message)
    if (!use || !groupable.has(use.name)) continue
    const key = `${(message as NormalizedAssistantMessage).message.id}::${use.name}`
    const members = groups.get(key) ?? []
    members.push(message as NormalizedAssistantMessage<ToolUseBlock>)
    groups.set(key, members)
    groupKeyByMessage.set(message, key)
  }
  const validKeys = new Set([...groups.entries()].filter(([, members]) => members.length >= 2).map(([key]) => key))

  const groupedIds = new Set<string>()
  for (const key of validKeys) {
    for (const member of groups.get(key) as NormalizedAssistantMessage<ToolUseBlock>[]) {
      groupedIds.add((member.message.content[0] as ToolUseBlock).id)
    }
  }
  const resultByToolUseId = new Map<string, NormalizedUserMessage>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of message.message.content) {
      const record = block as { type?: string; tool_use_id?: string }
      if (record.type === 'tool_result' && record.tool_use_id && groupedIds.has(record.tool_use_id)) {
        resultByToolUseId.set(record.tool_use_id, message)
      }
    }
  }

  const output: GroupingResult['messages'] = []
  const emitted = new Set<string>()
  for (const message of messages) {
    const key = groupKeyByMessage.get(message)
    if (key !== undefined && validKeys.has(key)) {
      if (emitted.has(key)) continue
      emitted.add(key)
      const members = groups.get(key) as NormalizedAssistantMessage<ToolUseBlock>[]
      const first = members[0] as NormalizedAssistantMessage<ToolUseBlock>
      const results: NormalizedUserMessage[] = []
      for (const member of members) {
        const result = resultByToolUseId.get((member.message.content[0] as ToolUseBlock).id)
        if (result) results.push(result)
      }
      output.push({
        type: 'grouped_tool_use',
        toolName: (first.message.content[0] as ToolUseBlock).name,
        messages: members,
        results,
        displayMessage: first,
        uuid: `grouped-${first.uuid}`,
        timestamp: first.timestamp,
        messageId: first.message.id,
      })
      continue
    }
    if (message.type === 'user') {
      const resultBlocks = message.message.content.filter(
        block => (block as { type?: string }).type === 'tool_result',
      ) as Array<{ tool_use_id?: string }>
      if (resultBlocks.length > 0 && resultBlocks.every(block => block.tool_use_id && groupedIds.has(block.tool_use_id))) {
        continue
      }
    }
    output.push(message)
  }
  return { messages: output }
}
