import type { Tools } from '../../Tool.js'
import type { ContentBlockParam } from '../../types/wire.js'
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
} from '../api/errors.js'
import { mediaRefusalOf } from '../../utils/api/mediaRefusal.js'
import { isSyntheticApiErrorMessage } from '../../utils/messages/factories.js'
import {
  isSystemLocalCommandMessage,
  reorderAttachmentsForAPI,
} from './apiViewRows.js'
import { joinBatchedContent } from '../../utils/messages/batchedContent.js'
import { storedBlocksOf } from '../../rows/content.js'
import { normalizeAttachmentForAPI } from './attachmentText.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { mergeAssistantMessages, mergeUserMessages, mergeUserMessagesAndToolResults, isToolResultMessage } from './merge.js'
import { isTurnCutText } from '../../utils/messages/turnCut.js'
import { pairConversationMessages } from '../../utils/messages/resultPairing.js'
import { dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent } from './apiFilters.js'
import { stripToolReferenceBlocksFromUserMessage, stripUnavailableToolReferencesFromUserMessage, withToolReferenceTurnBoundary } from './apiViewRows.js'
import { isToolSearchEnabledOptimistic } from './toolSearch.js'
import { normalizeToolInputForAPI } from './api.js'
import { toolMatchesName } from '../../Tool.js'
import { validateImagesForAPI } from '../imageValidation.js'
import { LOCAL_COMMAND_CAVEAT_TAG } from '../../constants/xml.js'
import { IMAGE_ELIDED_TEXT } from '../../utils/messages/imageRequestFit.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function isLocalCommandCaveat(message: Message): message is UserMessage {
  return notBuilt('src/services/messages/apiPlan.ts:47')
}

export function withoutOrphanCaveats<M extends Message>(messages: M[]): M[] {
  return notBuilt('src/services/messages/apiPlan.ts:57')
}

export type PlannedMessage = Unbuilt

export type ApiConversationPlan = Unbuilt

export function errorDrivenStripTargets(messages: Message[]): Map<string, Set<string>> {
  return notBuilt('src/services/messages/apiPlan.ts:124')
}

export function applyStripTargets(
  message: UserMessage,
  stripTargets: ReadonlyMap<string, Set<string>>,
): UserMessage | null {
  return notBuilt('src/services/messages/apiPlan.ts:128')
}

export function applyStripTargetsToMessages(
  messages: Message[],
  stripTargets: ReadonlyMap<string, Set<string>>,
): Message[] {
  return notBuilt('src/services/messages/apiPlan.ts:144')
}

export function stripImagesRefusedByStamp<M extends Message>(rows: M[]): M[] {
  return notBuilt('src/services/messages/apiPlan.ts:185')
}

export function planApiConversation(
  messages: Message[],
  tools?: Tools,
): ApiConversationPlan {
  return notBuilt('src/services/messages/apiPlan.ts:222')
}

function foldBatchedRows(messages: PlannedMessage[]): PlannedMessage[] {
  const out: PlannedMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const head = messages[i]!
    const batch = head.type === 'user' ? head.batchUuids : undefined
    if (head.type !== 'user' || batch === undefined || batch.length < 2) {
      out.push(head)
      continue
    }
    const values: Array<string | ContentBlockParam[]> = [head.message.content]
    let j = i + 1
    for (; j < messages.length; j++) {
      const next = messages[j]!
      if (next.type !== 'user' || next.uuid === head.uuid || !batch.includes(next.uuid)) break
      values.push(next.message.content)
    }
    out.push(values.length === 1 ? head : { ...head, message: { ...head.message, content: joinBatchedContent(values) } })
    i = j - 1
  }
  return out
}
export type RequestConversationPlan = Unbuilt

export function requestConversationPlan(
  messages: readonly Message[],
  tools?: Tools,
  geometry?: 'anthropic' | 'family',
): RequestConversationPlan {
  return notBuilt('src/services/messages/apiPlan.ts:273')
}

function finishApiContent(messages: (UserMessage | AssistantMessage)[]): (UserMessage | AssistantMessage)[] {
  let rows = messages
  for (const stage of [dropEmptyTextBlocks, filterOrphanedThinkingOnlyMessages, filterTrailingThinkingFromLastAssistant, filterWhitespaceOnlyAssistantMessages, ensureNonEmptyAssistantContent, sanitizeErrorToolResultContent]) {
    rows = stage(rows) as (UserMessage | AssistantMessage)[]
  }
  validateImagesForAPI(rows)
  return rows
}
