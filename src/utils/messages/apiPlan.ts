import type { Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../../services/api/errors.js'
import { isSyntheticApiErrorMessage } from './factories.js'
import {
  isSystemLocalCommandMessage,
  reorderAttachmentsForAPI,
} from './apiView.js'

export type PlannedMessage =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemLocalCommandMessage

export type ApiConversationPlan = {
  selected: PlannedMessage[]
  stripTargets: Map<string, Set<string>>
  availableToolNames: Set<string>
}

export function planApiConversation(
  messages: Message[],
  tools: Tools = [],
): ApiConversationPlan {
  const availableToolNames = new Set(tools.map(t => t.name))

  const reorderedMessages = reorderAttachmentsForAPI(messages).filter(
    m => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
  )

  const errorToBlockTypes: Record<string, Set<string>> = {
    [getPdfTooLargeErrorMessage()]: new Set(['document']),
    [getPdfPasswordProtectedErrorMessage()]: new Set(['document']),
    [getPdfInvalidErrorMessage()]: new Set(['document']),
    [getImageTooLargeErrorMessage()]: new Set(['image']),
    [getRequestTooLargeErrorMessage()]: new Set(['document', 'image']),
  }

  const stripTargets = new Map<string, Set<string>>()
  for (let i = 0; i < reorderedMessages.length; i++) {
    const msg = reorderedMessages[i]!
    if (!isSyntheticApiErrorMessage(msg)) {
      continue
    }
    const errorText =
      Array.isArray(msg.message.content) &&
      msg.message.content[0]?.type === 'text'
        ? msg.message.content[0].text
        : undefined
    if (!errorText) {
      continue
    }
    const blockTypesToStrip = errorToBlockTypes[errorText]
    if (!blockTypesToStrip) {
      continue
    }
    for (let j = i - 1; j >= 0; j--) {
      const candidate = reorderedMessages[j]!
      if (candidate.type === 'user' && candidate.isMeta) {
        const existing = stripTargets.get(candidate.uuid)
        if (existing) {
          for (const t of blockTypesToStrip) {
            existing.add(t)
          }
        } else {
          stripTargets.set(candidate.uuid, new Set(blockTypesToStrip))
        }
        break
      }
      if (isSyntheticApiErrorMessage(candidate)) {
        continue
      }
      break
    }
  }

  const selected = reorderedMessages.filter(
    (m): m is PlannedMessage => {
      if (
        m.type === 'progress' ||
        (m.type === 'system' && !isSystemLocalCommandMessage(m)) ||
        isSyntheticApiErrorMessage(m)
      ) {
        return false
      }
      return true
    },
  )

  return { selected, stripTargets, availableToolNames }
}
