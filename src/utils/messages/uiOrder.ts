
import type {
  AttachmentMessage,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  SystemMessage,
} from '../../types/message.js'
import { isHookAttachmentMessage } from './lookups.js'
import { isToolUseRequestMessage } from './normalize.js'

type DisplayMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage

type ToolUseGroup = {
  use: DisplayMessage | null
  preHooks: DisplayMessage[]
  result: DisplayMessage | null
  postHooks: DisplayMessage[]
}

type DisplayRole =
  | { kind: 'use'; toolUseID: string }
  | { kind: 'use-unkeyed' }
  | { kind: 'pre-hook'; toolUseID: string }
  | { kind: 'result'; toolUseID: string }
  | { kind: 'post-hook'; toolUseID: string }
  | { kind: 'api-error' }
  | { kind: 'standalone' }

function classify(message: DisplayMessage): DisplayRole {
  if (isToolUseRequestMessage(message)) {
    const toolUseID = message.message.content[0]?.id
    return toolUseID ? { kind: 'use', toolUseID } : { kind: 'use-unkeyed' }
  }
  if (isHookAttachmentMessage(message)) {
    if (message.attachment.hookEvent === 'PreToolUse') {
      return { kind: 'pre-hook', toolUseID: message.attachment.toolUseID }
    }
    if (message.attachment.hookEvent === 'PostToolUse') {
      return { kind: 'post-hook', toolUseID: message.attachment.toolUseID }
    }
    return { kind: 'standalone' }
  }
  if (
    message.type === 'user' &&
    message.message.content[0]?.type === 'tool_result'
  ) {
    return { kind: 'result', toolUseID: message.message.content[0].tool_use_id }
  }
  if (message.type === 'system' && message.subtype === 'api_error') {
    return { kind: 'api-error' }
  }
  return { kind: 'standalone' }
}

export function reorderMessagesInUI(
  messages: DisplayMessage[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): DisplayMessage[] {
  const roles = messages.map(classify)
  const groups = new Map<string, ToolUseGroup>()
  const groupFor = (toolUseID: string): ToolUseGroup => {
    let g = groups.get(toolUseID)
    if (!g) {
      g = { use: null, preHooks: [], result: null, postHooks: [] }
      groups.set(toolUseID, g)
    }
    return g
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const role = roles[i]!
    switch (role.kind) {
      case 'use':
        groupFor(role.toolUseID).use = message
        break
      case 'pre-hook':
        groupFor(role.toolUseID).preHooks.push(message)
        break
      case 'result':
        groupFor(role.toolUseID).result = message
        break
      case 'post-hook':
        groupFor(role.toolUseID).postHooks.push(message)
        break
      default:
        break
    }
  }

  const result: DisplayMessage[] = []
  const emittedGroups = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const role = roles[i]!
    switch (role.kind) {
      case 'use': {
        if (emittedGroups.has(role.toolUseID)) break
        emittedGroups.add(role.toolUseID)
        const group = groups.get(role.toolUseID)!
        result.push(group.use!, ...group.preHooks)
        if (group.result) result.push(group.result)
        result.push(...group.postHooks)
        break
      }
      case 'use-unkeyed':
      case 'pre-hook':
      case 'result':
      case 'post-hook':
        break
      case 'api-error': {
        const previous = result.at(-1)
        if (previous?.type === 'system' && previous.subtype === 'api_error') {
          result[result.length - 1] = message
        } else {
          result.push(message)
        }
        break
      }
      case 'standalone':
        result.push(message)
        break
    }
  }

  result.push(...syntheticStreamingToolUseMessages)

  const last = result.at(-1)
  return result.filter(
    m => m.type !== 'system' || m.subtype !== 'api_error' || m === last,
  )
}
