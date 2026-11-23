import type {
  AttachmentMessage,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  SystemMessage,
} from '../../engine/message-shapes/message.js'
import { isToolUseRequestMessage } from '../../engine/message-shapes/normalize.js'
import { isHookAttachmentMessage } from '../../engine/messages/lookups.js'

type DisplayMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage

type RowRole =
  | { kind: 'tool_use'; id: string }
  | { kind: 'unkeyed_tool_use' }
  | { kind: 'pre_hook'; id: string }
  | { kind: 'post_hook'; id: string }
  | { kind: 'tool_result'; id: string }
  | { kind: 'api_error' }
  | { kind: 'standalone' }

type ToolUseGroup = {
  use?: DisplayMessage
  preHooks: DisplayMessage[]
  result?: DisplayMessage
  postHooks: DisplayMessage[]
}

function isApiErrorRow(message: DisplayMessage): boolean {
  return message.type === 'system' && message.subtype === 'api_error'
}

function classifyRow(message: DisplayMessage): RowRole {
  if (isToolUseRequestMessage(message)) {
    const id = message.message.content[0]?.id
    return id ? { kind: 'tool_use', id } : { kind: 'unkeyed_tool_use' }
  }
  if (isHookAttachmentMessage(message)) {
    const { callId, event } = message.attachment
    if (callId !== undefined) {
      if (event === 'tool.before') return { kind: 'pre_hook', id: callId }
      if (event === 'tool.after' || event === 'permission.decided') {
        return { kind: 'post_hook', id: callId }
      }
    }
    return { kind: 'standalone' }
  }
  if (message.type === 'user') {
    const first = message.message.content[0]
    if (first?.type === 'tool_result') {
      return { kind: 'tool_result', id: first.tool_use_id }
    }
  }
  if (isApiErrorRow(message)) {
    return { kind: 'api_error' }
  }
  return { kind: 'standalone' }
}

function getOrCreateGroup(groups: Map<string, ToolUseGroup>, id: string): ToolUseGroup {
  let group = groups.get(id)
  if (group === undefined) {
    group = { preHooks: [], postHooks: [] }
    groups.set(id, group)
  }
  return group
}

export function reorderMessagesInUI(
  messages: DisplayMessage[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): DisplayMessage[] {
  const roles = messages.map(classifyRow)
  const groups = new Map<string, ToolUseGroup>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const role = roles[i]!
    switch (role.kind) {
      case 'tool_use':
        getOrCreateGroup(groups, role.id).use = message
        break
      case 'pre_hook':
        getOrCreateGroup(groups, role.id).preHooks.push(message)
        break
      case 'tool_result':
        getOrCreateGroup(groups, role.id).result = message
        break
      case 'post_hook':
        getOrCreateGroup(groups, role.id).postHooks.push(message)
        break
      case 'unkeyed_tool_use':
      case 'api_error':
      case 'standalone':
        break
    }
  }

  const emitted: DisplayMessage[] = []
  const emittedGroupIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const role = roles[i]!
    switch (role.kind) {
      case 'tool_use': {
        if (emittedGroupIds.has(role.id)) break
        emittedGroupIds.add(role.id)
        const group = groups.get(role.id)
        if (group?.use === undefined) break
        emitted.push(group.use)
        emitted.push(...group.preHooks)
        if (group.result !== undefined) emitted.push(group.result)
        emitted.push(...group.postHooks)
        break
      }
      case 'api_error': {
        const previous = emitted[emitted.length - 1]
        if (previous !== undefined && isApiErrorRow(previous)) {
          emitted[emitted.length - 1] = message
        } else {
          emitted.push(message)
        }
        break
      }
      case 'standalone':
        emitted.push(message)
        break
      case 'unkeyed_tool_use':
      case 'pre_hook':
      case 'tool_result':
      case 'post_hook':
        break
    }
  }

  emitted.push(...syntheticStreamingToolUseMessages)

  const lastMessage = emitted[emitted.length - 1]
  return emitted.filter(message => !isApiErrorRow(message) || message === lastMessage)
}
