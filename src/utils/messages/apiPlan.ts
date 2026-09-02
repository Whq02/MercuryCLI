// ============================================================================
//  messages/apiPlan — the SEMANTIC-SELECTION phase of the API projection
//  (IDM-3/A07: the prompt plan separates semantic selection from
//  provider encoding).
//
//  This module decides WHAT is model-relevant; it never encodes a provider
//  shape. The provider ENCODER (apiView.normalizeMessagesForAPI) consumes
//  the plan and owns role coalescing, block projection, wire tags, and
//  request limits. The split is byte-parity-pinned by the R2 golden oracle
//  (prove-messages-parity) and the R6 request goldens — extracting a rule
//  into this phase must never change the encoded request.
//
//  Selection rules owned here:
//    · attachment reordering (bubble-up to the tool-result/assistant fence);
//    · virtual-message exclusion (display-only rows never reach the model);
//    · the error-driven strip map (a PDF/image/request-too-large error
//      strips the offending blocks from the SPECIFIC preceding meta user
//      message — an explicit omission decision, recorded per-uuid);
//    · the model-relevance predicate (progress rows and non-local-command
//      system rows are presentation, not conversation).
// ============================================================================
import type { Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
// (SystemLocalCommandMessage rides the shared taxonomy import above.)
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

/** A message the plan selected as model-relevant. */
export type PlannedMessage =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemLocalCommandMessage

export type ApiConversationPlan = {
  /** Model-relevant messages, in send order (pre-encoding). */
  selected: PlannedMessage[]
  /** Explicit omission decisions: user-message uuid → block types the
   *  encoder must strip (the error-driven strip map). */
  stripTargets: Map<string, Set<string>>
  /** Tool names available this sampling step (reference-repair input). */
  availableToolNames: Set<string>
}

/**
 * The semantic-selection phase: decide what the model sees, and record
 * every deliberate omission. Pure over its inputs.
 */
export function planApiConversation(
  messages: Message[],
  tools: Tools = [],
): ApiConversationPlan {
  const availableToolNames = new Set(tools.map(t => t.name))

  // Reorder attachments, then exclude display-only virtual rows.
  const reorderedMessages = reorderAttachmentsForAPI(messages).filter(
    m => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
  )

  // Error text → block types to strip from the preceding meta user message.
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
