// Message relationship lookups — the O(1) per-render indexes (siblings,
// progress, hook resolution, tool results) and their builders, plus the
// per-message tool-use-id resolver. The parity oracle (scripts/messages) pins behavior.

import type { ToolUseBlock, ToolUseBlockParam } from '../../types/wire.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  ProgressMessage,
} from '../../types/message.js'
import { count } from '../array.js'
import type {
  HookAttachment,
  HookPermissionDecisionAttachment,
} from '../attachments.js'
import {
  isContinuableStreamFaultMessage,
  isStreamFaultRecoveryNudgeText,
} from '../../services/api/errors.js'
import { contentBlocksOf } from './normalize.js'
import { isDenialResultText } from './rejectionText.js'

/** Best-effort text of a tool_result's content (string or text blocks) for
 *  the denial classifier — non-text blocks contribute nothing. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n')
  }
  return ''
}

/** Hook attachments that carry a hookName (everything but permission decisions). */
type HookAttachmentWithName = Exclude<
  HookAttachment,
  HookPermissionDecisionAttachment
>

// ── per-message resolvers ───────────────────────────────────────────────────

export function isHookAttachmentMessage(
  message: Message,
): message is AttachmentMessage<HookAttachment> {
  return (
    message.type === 'attachment' &&
    (message.attachment.type === 'hook_blocking_error' ||
      message.attachment.type === 'hook_cancelled' ||
      message.attachment.type === 'hook_error_during_execution' ||
      message.attachment.type === 'hook_non_blocking_error' ||
      message.attachment.type === 'hook_success' ||
      message.attachment.type === 'hook_system_message' ||
      message.attachment.type === 'hook_additional_context' ||
      message.attachment.type === 'hook_stopped_continuation')
  )
}

/** The tool_use id a normalized message belongs to, whatever its shape. */
export function getToolUseID(message: NormalizedMessage): string | null {
  switch (message.type) {
    case 'attachment':
      return isHookAttachmentMessage(message)
        ? message.attachment.toolUseID
        : null
    case 'assistant':
      return message.message.content[0]?.type === 'tool_use'
        ? message.message.content[0].id
        : null
    case 'user':
      if (message.sourceToolUseID) return message.sourceToolUseID
      return message.message.content[0]?.type === 'tool_result'
        ? message.message.content[0].tool_use_id
        : null
    case 'progress':
      return message.toolUseID
    case 'system':
      return message.subtype === 'informational'
        ? (message.toolUseID ?? null)
        : null
  }
}

// ── O(n) direct scans (legacy per-message paths; prefer the lookups) ────────

function getInProgressHookCount(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  return count(
    messages,
    m =>
      m.type === 'progress' &&
      m.data.type === 'hook_progress' &&
      m.data.hookEvent === hookEvent &&
      m.parentToolUseID === toolUseID,
  )
}

function getResolvedHookCount(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  // Dedup by hook name — one hook can emit several attachment messages
  // (e.g. hook_success + hook_additional_context).
  const uniqueHookNames = new Set(
    messages
      .filter(
        (m): m is AttachmentMessage<HookAttachmentWithName> =>
          isHookAttachmentMessage(m) &&
          m.attachment.toolUseID === toolUseID &&
          m.attachment.hookEvent === hookEvent,
      )
      .map(m => m.attachment.hookName),
  )
  return uniqueHookNames.size
}

export function hasUnresolvedHooks(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
) {
  return (
    getInProgressHookCount(messages, toolUseID, hookEvent) >
    getResolvedHookCount(messages, toolUseID, hookEvent)
  )
}

export function getToolResultIDs(normalizedMessages: NormalizedMessage[]): {
  [toolUseID: string]: boolean
} {
  return Object.fromEntries(
    normalizedMessages.flatMap(m =>
      m.type === 'user' && m.message.content[0]?.type === 'tool_result'
        ? [
            [
              m.message.content[0].tool_use_id,
              m.message.content[0].is_error ?? false,
            ],
          ]
        : ([] as [string, boolean][]),
    ),
  )
}

/** O(n) sibling scan: every tool_use id sharing the message's API message id. */
export function getSiblingToolUseIDs(
  message: NormalizedMessage,
  messages: Message[],
): Set<string> {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) return new Set()

  const owner = messages.find(
    (m): m is AssistantMessage =>
      m.type === 'assistant' &&
      contentBlocksOf(m.message.content).some(b => b.type === 'tool_use' && b.id === toolUseID),
  )
  if (!owner) return new Set()

  const messageID = owner.message.id
  const siblings = messages.filter(
    (m): m is AssistantMessage =>
      m.type === 'assistant' && m.message.id === messageID,
  )
  return new Set(
    siblings.flatMap(m =>
      contentBlocksOf(m.message.content)
        .filter(b => b.type === 'tool_use')
        .map(b => b.id),
    ),
  )
}

// ── the pre-computed lookups ────────────────────────────────────────────────

export type MessageLookups = {
  siblingToolUseIDs: Map<string, Set<string>>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: Map<string, Map<HookEvent, number>>
  resolvedHookCounts: Map<string, Map<HookEvent, number>>
  /** tool_use_id → the user message containing its tool_result */
  toolResultByToolUseID: Map<string, NormalizedMessage>
  /** tool_use_id → the ToolUseBlockParam */
  toolUseByToolUseID: Map<string, ToolUseBlockParam>
  /** Total normalized message count (truncation indicator text). */
  normalizedMessageCount: number
  /** tool_use ids with a corresponding tool_result */
  resolvedToolUseIDs: Set<string>
  /** tool_use ids whose tool_result errored */
  erroredToolUseIDs: Set<string>
  /** errored ids whose result is a DENIAL (permission rejected / interrupt) —
   *  the ✕ CRIMSON set; errored-but-not-denied rows wear the ▲ warn lead. */
  deniedToolUseIDs: Set<string>
  /** uuids of continuable stream-fault messages the run
   *  RECOVERED from (the owned recovery nudge follows them) — these render as
   *  the restrained ▲ "resumed" row, never the terminal CRIMSON card. A fault
   *  with no nudge after it (recovery declined / second fault) stays loud. */
  recoveredStreamFaultUuids: Set<string>
}

/**
 * Build every per-render relationship index in two passes (one over raw
 * messages for the sibling graph, one over normalized messages for the rest)
 * — the O(1) replacement for the per-message O(n) scans above.
 */
export function buildMessageLookups(
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): MessageLookups {
  // Pass 1 (raw): the tool_use ownership graph, keyed by API message id.
  const toolUseIDsByMessageID = new Map<string, Set<string>>()
  const toolUseIDToMessageID = new Map<string, string>()
  const toolUseByToolUseID = new Map<string, ToolUseBlockParam>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const id = msg.message.id
    let toolUseIDs = toolUseIDsByMessageID.get(id)
    if (!toolUseIDs) {
      toolUseIDs = new Set()
      toolUseIDsByMessageID.set(id, toolUseIDs)
    }
    for (const content of contentBlocksOf(msg.message.content)) {
      if (content.type === 'tool_use') {
        toolUseIDs.add(content.id)
        toolUseIDToMessageID.set(content.id, id)
        toolUseByToolUseID.set(content.id, content)
      }
    }
  }

  const siblingToolUseIDs = new Map<string, Set<string>>()
  for (const [toolUseID, messageID] of toolUseIDToMessageID) {
    siblingToolUseIDs.set(toolUseID, toolUseIDsByMessageID.get(messageID)!)
  }

  // Pass 2 (normalized): progress, hook counts, tool results.
  const progressMessagesByToolUseID = new Map<string, ProgressMessage[]>()
  const inProgressHookCounts = new Map<string, Map<HookEvent, number>>()
  // Unique hook names per (toolUseID, hookEvent) — mirrors getResolvedHookCount.
  const resolvedHookNames = new Map<string, Map<HookEvent, Set<string>>>()
  const toolResultByToolUseID = new Map<string, NormalizedMessage>()
  const resolvedToolUseIDs = new Set<string>()
  const erroredToolUseIDs = new Set<string>()
  const deniedToolUseIDs = new Set<string>()
  // continuable stream faults whose owned recovery nudge
  // appears LATER in the transcript = the run resumed past them.
  const recoveredStreamFaultUuids = new Set<string>()
  const pendingStreamFaultUuids: string[] = []

  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      const toolUseID = msg.parentToolUseID
      const existing = progressMessagesByToolUseID.get(toolUseID)
      if (existing) existing.push(msg)
      else progressMessagesByToolUseID.set(toolUseID, [msg])

      if (msg.data.type === 'hook_progress') {
        const hookEvent = msg.data.hookEvent
        let byHookEvent = inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    if (msg.type === 'user') {
      if (pendingStreamFaultUuids.length > 0 && Array.isArray(msg.message.content)) {
        // The turn machine appends the nudge IMMEDIATELY after the fault it
        // recovers, so the FIRST user message after a pending fault decides
        // it: the nudge ⇒ recovered; anything else (a fresh prompt, an
        // interruption) ⇒ the fault surfaced terminally and its run ended.
        // Either way the pending set clears — without the terminal boundary,
        // a later run's nudge retroactively repainted a terminal fault as
        // "resumed".
        if (
          msg.message.content.some(
            c => c.type === 'text' && isStreamFaultRecoveryNudgeText(c.text),
          )
        ) {
          for (const uuid of pendingStreamFaultUuids) recoveredStreamFaultUuids.add(uuid)
        }
        pendingStreamFaultUuids.length = 0
      }
      for (const content of contentBlocksOf(msg.message.content)) {
        if (content.type === 'tool_result') {
          toolResultByToolUseID.set(content.tool_use_id, msg)
          resolvedToolUseIDs.add(content.tool_use_id)
          if (content.is_error) {
            erroredToolUseIDs.add(content.tool_use_id)
            if (isDenialResultText(toolResultText(content.content))) {
              deniedToolUseIDs.add(content.tool_use_id)
            }
          }
        }
      }
    }

    if (msg.type === 'assistant') {
      if (isContinuableStreamFaultMessage(msg as unknown as AssistantMessage)) {
        pendingStreamFaultUuids.push(msg.uuid)
      }
      for (const content of contentBlocksOf(msg.message.content)) {
        // Any block carrying a tool_use_id is a server-side result
        // (advisor/web_search/code_execution/mcp *_tool_result families).
        if (
          'tool_use_id' in content &&
          typeof (content as { tool_use_id: string }).tool_use_id === 'string'
        ) {
          resolvedToolUseIDs.add(
            (content as { tool_use_id: string }).tool_use_id,
          )
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as {
            tool_use_id: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            erroredToolUseIDs.add(result.tool_use_id)
          }
        }
      }
    }

    if (isHookAttachmentMessage(msg)) {
      const toolUseID = msg.attachment.toolUseID
      const hookEvent = msg.attachment.hookEvent
      const hookName = (msg.attachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        let byHookEvent = resolvedHookNames.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          resolvedHookNames.set(toolUseID, byHookEvent)
        }
        let names = byHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          byHookEvent.set(hookEvent, names)
        }
        names.add(hookName)
      }
    }
  }

  const resolvedHookCounts = new Map<string, Map<HookEvent, number>>()
  for (const [toolUseID, byHookEvent] of resolvedHookNames) {
    const countMap = new Map<HookEvent, number>()
    for (const [hookEvent, names] of byHookEvent) {
      countMap.set(hookEvent, names.size)
    }
    resolvedHookCounts.set(toolUseID, countMap)
  }

  // Orphaned server_tool_use / mcp_tool_use blocks (no result) render as
  // failed rather than spinning forever — except blocks of the last original
  // assistant message, which may still be streaming.
  const lastMsg = messages.at(-1)
  const lastAssistantMsgId =
    lastMsg?.type === 'assistant' ? lastMsg.message.id : undefined
  for (const msg of normalizedMessages) {
    if (msg.type !== 'assistant') continue
    if (msg.message.id === lastAssistantMsgId) continue
    for (const content of contentBlocksOf(msg.message.content)) {
      if (
        (content.type === 'server_tool_use' ||
          content.type === 'mcp_tool_use') &&
        !resolvedToolUseIDs.has((content as { id: string }).id)
      ) {
        const id = (content as { id: string }).id
        resolvedToolUseIDs.add(id)
        erroredToolUseIDs.add(id)
      }
    }
  }

  return {
    siblingToolUseIDs,
    progressMessagesByToolUseID,
    inProgressHookCounts,
    resolvedHookCounts,
    toolResultByToolUseID,
    toolUseByToolUseID,
    normalizedMessageCount: normalizedMessages.length,
    resolvedToolUseIDs,
    erroredToolUseIDs,
    recoveredStreamFaultUuids,
    deniedToolUseIDs,
  }
}

/** Empty lookups for static rendering contexts. */
export const EMPTY_LOOKUPS: MessageLookups = {
  siblingToolUseIDs: new Map(),
  progressMessagesByToolUseID: new Map(),
  inProgressHookCounts: new Map(),
  resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
  normalizedMessageCount: 0,
  resolvedToolUseIDs: new Set(),
  erroredToolUseIDs: new Set(),
  recoveredStreamFaultUuids: new Set(),
  deniedToolUseIDs: new Set(),
}

/**
 * Shared empty-set singleton for bail-out paths (no per-message-per-render
 * allocation). Compile-time readonly via ReadonlySet; Object.freeze is
 * convention only (it can't freeze Set internals). Consumers only iterate /
 * .has / .size.
 */
export const EMPTY_STRING_SET: ReadonlySet<string> = Object.freeze(
  new Set<string>(),
)

/**
 * Lookups from subagent/skill progress payloads (each carries a `message` of
 * type AssistantMessage | NormalizedUserMessage) so child tool uses render
 * with correct resolved/in-progress state.
 */
export function buildSubagentLookups(
  messages: { message: AssistantMessage | NormalizedUserMessage }[],
): { lookups: MessageLookups; inProgressToolUseIDs: Set<string> } {
  const toolUseByToolUseID = new Map<string, ToolUseBlockParam>()
  const resolvedToolUseIDs = new Set<string>()
  const toolResultByToolUseID = new Map<
    string,
    NormalizedUserMessage & { type: 'user' }
  >()

  for (const { message: msg } of messages) {
    if (msg.type === 'assistant') {
      for (const content of contentBlocksOf(msg.message.content)) {
        if (content.type === 'tool_use') {
          toolUseByToolUseID.set(content.id, content as ToolUseBlockParam)
        }
      }
    } else if (msg.type === 'user') {
      for (const content of contentBlocksOf(msg.message.content)) {
        if (content.type === 'tool_result') {
          resolvedToolUseIDs.add(content.tool_use_id)
          toolResultByToolUseID.set(content.tool_use_id, msg)
        }
      }
    }
  }

  const inProgressToolUseIDs = new Set<string>()
  for (const id of toolUseByToolUseID.keys()) {
    if (!resolvedToolUseIDs.has(id)) inProgressToolUseIDs.add(id)
  }

  return {
    lookups: {
      ...EMPTY_LOOKUPS,
      toolUseByToolUseID,
      resolvedToolUseIDs,
      toolResultByToolUseID,
    },
    inProgressToolUseIDs,
  }
}

// ── O(1) accessors over the lookups ─────────────────────────────────────────

export function getSiblingToolUseIDsFromLookup(
  message: NormalizedMessage,
  lookups: MessageLookups,
): ReadonlySet<string> {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) return EMPTY_STRING_SET
  return lookups.siblingToolUseIDs.get(toolUseID) ?? EMPTY_STRING_SET
}

export function getProgressMessagesFromLookup(
  message: NormalizedMessage,
  lookups: MessageLookups,
): ProgressMessage[] {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) return []
  return lookups.progressMessagesByToolUseID.get(toolUseID) ?? []
}

export function hasUnresolvedHooksFromLookup(
  toolUseID: string,
  hookEvent: HookEvent,
  lookups: MessageLookups,
): boolean {
  const inProgressCount =
    lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  const resolvedCount =
    lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  return inProgressCount > resolvedCount
}

export function getToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  return new Set(
    normalizedMessages
      .filter(
        (m): m is NormalizedAssistantMessage<ToolUseBlock> =>
          m.type === 'assistant' &&
          Array.isArray(m.message.content) &&
          m.message.content[0]?.type === 'tool_use',
      )
      .map(m => m.message.content[0].id),
  )
}

// ── conversation-scan getters ───────────────────────────────────────────────

export function getLastAssistantMessage(
  messages: Message[],
): AssistantMessage | undefined {
  // findLast exits early from the end — much faster than filter+last on large
  // arrays (called on every REPL render via useFeedbackSurvey).
  return messages.findLast(
    (msg: Message): msg is AssistantMessage => msg.type === 'assistant',
  )
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      const content = (message as AssistantMessage).message.content
      if (Array.isArray(content)) {
        return content.some(block => block.type === 'tool_use')
      }
    }
  }
  return false
}
