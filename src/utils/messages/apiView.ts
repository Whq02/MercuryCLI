// The API projection — normalizeMessagesForAPI and its supporting passes:
// attachment bubbling, virtual-strip, tool_reference hygiene (strip /
// relocate / turn-boundary), targeted large-content strips after synthetic
// API errors, role coalescing, and the multi-pass API-invariant pipeline.
// Owned Mercury module:
// the pipeline's pass ORDER is behavior (each pass can create conditions a
// prior pass handles), so the ownership pass reorganizes the module but
// preserves the passes byte-for-byte. The parity oracle pins the output.

import type { ContentBlock, ContentBlockParam, ApiMessage } from '../../types/wire.js'
import isObject from 'lodash-es/isObject.js'
import last from 'lodash-es/last.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type { AgentId } from 'src/types/ids.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../../services/api/errors.js'
import {
  findToolByName,
  toolMatchesName,
  type Tools,
} from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import { normalizeToolInput, normalizeToolInputForAPI } from '../api.js'
import { contentBlocksOf } from './normalize.js'
import { logForDebugging } from '../debug.js'
import { validateImagesForAPI } from '../imageValidation.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { normalizeLegacyToolName } from '../permissions/permissionRuleParser.js'
import {
  isToolReferenceBlock,
  isToolSearchEnabledOptimistic,
} from '../toolSearch.js'
import {
  ensureNonEmptyAssistantContent,
  filterOrphanedThinkingOnlyMessages,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistantMessages,
  sanitizeErrorToolResultContent,
} from './apiFilters.js'
import { normalizeAttachmentForAPI } from './attachmentText.js'
import { createUserMessage } from './factories.js'
import { planApiConversation } from './apiPlan.js'
import {
  isToolResultMessage,
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
} from './merge.js'

const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

/**
 * Bubble attachments upward through the transcript until each hits a
 * stopping point — a tool_result-carrying user message or any assistant
 * message. Attachments land immediately AFTER their stopping point, in
 * their original relative order.
 */
export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  // `result` builds BACKWARDS (push) and reverses once at the end — one
  // O(N) pass; an unshift-per-message loop would cost O(N²).
  const result: Message[] = []
  // The bottom-up scan pushes attachments as it meets them, so this buffer
  // holds each group in reverse of input order until its release point.
  const pendingAttachments: AttachmentMessage[] = []

  // Bottom-up scan: collect attachments, release them at stopping points.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!

    if (message.type === 'attachment') {
      pendingAttachments.push(message)
    } else {
      const isStoppingPoint =
        message.type === 'assistant' ||
        (message.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content[0]?.type === 'tool_result')

      if (isStoppingPoint && pendingAttachments.length > 0) {
        // Release: pendingAttachments is already in reverse input order, so
        // after the final result.reverse() the group reads in original
        // order, immediately after `message`.
        for (let j = 0; j < pendingAttachments.length; j++) {
          result.push(pendingAttachments[j]!)
        }
        result.push(message)
        pendingAttachments.length = 0
      } else {
        result.push(message)
      }
    }
  }

  // No stopping point above them ⇒ these ride at the very top.
  for (let j = 0; j < pendingAttachments.length; j++) {
    result.push(pendingAttachments[j]!)
  }

  result.reverse()
  return result
}

export function isSystemLocalCommandMessage(
  message: Message,
): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

/**
 * Drop tool_reference blocks whose tool does not exist (a resumed session
 * can carry references to MCP tools whose server has since disconnected,
 * renamed, or vanished). Left in, the API rejects the request with "Tool
 * reference not found in available tools".
 */
function stripUnavailableToolReferencesFromUserMessage(
  message: UserMessage,
  availableToolNames: Set<string>,
): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  // Cheap pre-scan: untouched messages return by reference.
  const hasUnavailableReference = content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(c => {
        if (!isToolReferenceBlock(c)) return false
        const toolName = (c as { tool_name?: string }).tool_name
        return (
          toolName && !availableToolNames.has(normalizeLegacyToolName(toolName))
        )
      }),
  )

  if (!hasUnavailableReference) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
          return block
        }

        const filteredContent = block.content.filter(c => {
          if (!isToolReferenceBlock(c)) return true
          const rawToolName = (c as { tool_name?: string }).tool_name
          if (!rawToolName) return true
          const toolName = normalizeLegacyToolName(rawToolName)
          const isAvailable = availableToolNames.has(toolName)
          if (!isAvailable) {
            logForDebugging(
              `Filtering out tool_reference for unavailable tool: ${toolName}`,
              { level: 'warn' },
            )
          }
          return isAvailable
        })

        // A tool_result must keep SOME content — an emptied block gets a
        // placeholder text block instead of going out hollow.
        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: '[Tool references removed - tools no longer available]',
              },
            ],
          }
        }

        return {
          ...block,
          content: filteredContent,
        }
      }),
    },
  }
}

// (appendMessageTagToUserMessage — the snip-tool [id:] tag pass — was
// deleted here: its call site had already been removed with the
// snip tool itself, leaving a zero-caller function and a comment claiming
// tags were appended when nothing was. deriveShortMessageId stays in
// identity.ts for the surfaces that still derive short ids.)

/**
 * Strip EVERY tool_reference block from a user message's tool_results.
 * tool_reference is only legal under the tool-search beta — with the beta
 * off, any survivor is an API error waiting on the wire.
 */
export function stripToolReferenceBlocksFromUserMessage(
  message: UserMessage,
): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  const hasToolReference = content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )

  if (!hasToolReference) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
          return block
        }

        const filteredContent = block.content.filter(
          c => !isToolReferenceBlock(c),
        )

        // A block that was ALL tool_reference gets a placeholder — a
        // tool_result cannot go out hollow.
        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: '[Tool references removed - tool search not enabled]',
              },
            ],
          }
        }

        return {
          ...block,
          content: filteredContent,
        }
      }),
    },
  }
}

/**
 * Strip the tool-search-only 'caller' field from an assistant message's
 * tool_use blocks (illegal on the wire with the beta off).
 *
 * Deliberately does NOT normalize tool inputs: this helper runs in
 * model-specific post-processing AFTER normalizeMessagesForAPI, where
 * inputs are already normalized — normalizing twice is the bug this note
 * prevents.
 */
export function stripCallerFieldFromAssistantMessage(
  message: AssistantMessage,
): AssistantMessage {
  const hasCallerField = message.message.content.some(
    block =>
      block.type === 'tool_use' && 'caller' in block && block.caller !== null,
  )

  if (!hasCallerField) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map(block => {
        if (block.type !== 'tool_use') {
          return block
        }
        // Rebuilt from the standard fields only — anything else is dropped.
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }),
    },
  }
}

/** Any tool_result in this content carrying a tool_reference block? */
function contentHasToolReference(
  content: ReadonlyArray<ContentBlockParam>,
): boolean {
  return content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )
}

// The error-tool_result sanitizer lives in apiFilters.ts.
// (relocateToolReferenceSiblings — the gated sibling-relocation variant of
// the turn-boundary fix — was deleted in the cut: production-dead
// behind mercury_toolref_defer_j8m; see the deletion record on
// mergeUserContentBlocks in merge.ts. The TOOL_REFERENCE_TURN_BOUNDARY
// injection below is the live arm of that fix.)

export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools = [],
): (UserMessage | AssistantMessage)[] {
  // IDM-3/A07: semantic selection is the PLANNER's phase
  // (messages/apiPlan.ts); this function is the provider ENCODER over the
  // plan — role coalescing, block projection, wire tags, request limits.
  // The split is byte-parity-pinned by the R2/R6 goldens.
  const { selected, stripTargets, availableToolNames } = planApiConversation(
    messages,
    tools,
  )

  const result: (UserMessage | AssistantMessage)[] = []
  selected
    .forEach(message => {
      switch (message.type) {
        case 'system': {
          // A local_command system message becomes a user message on the
          // wire — earlier command output must stay referenceable by the
          // model in later turns.
          const userMsg = createUserMessage({
            content: message.content,
            uuid: message.uuid,
            timestamp: message.timestamp,
          })
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(lastMessage, userMsg)
            return
          }
          result.push(userMsg)
          return
        }
        case 'user': {
          // Consecutive user messages coalesce into ONE user turn: Bedrock
          // rejects back-to-back user messages outright, and the 1P API
          // would silently merge them anyway — coalescing here makes the
          // wire shape explicit and provider-uniform.

          // tool_reference hygiene, by beta state: beta OFF strips ALL
          // tool_reference blocks (illegal without the header); beta ON
          // strips only references to tools that do not exist.
          let normalizedMessage = message
          if (!isToolSearchEnabledOptimistic()) {
            normalizedMessage = stripToolReferenceBlocksFromUserMessage(message)
          } else {
            normalizedMessage = stripUnavailableToolReferencesFromUserMessage(
              message,
              availableToolNames,
            )
          }

          // Targeted post-error strips: the planner marked the exact meta
          // message whose document/image content triggered a synthetic
          // PDF/image/too-large API error — without the strip, every later
          // request would re-send the same poison and re-fail.
          const typesToStrip = stripTargets.get(normalizedMessage.uuid)
          if (typesToStrip && normalizedMessage.isMeta) {
            const content = normalizedMessage.message.content
            if (Array.isArray(content)) {
              const filtered = content.filter(
                block => !typesToStrip.has(block.type),
              )
              if (filtered.length === 0) {
                // Nothing survived the strip ⇒ the message itself goes.
                return
              }
              if (filtered.length < content.length) {
                normalizedMessage = {
                  ...normalizedMessage,
                  message: {
                    ...normalizedMessage.message,
                    content: filtered,
                  },
                }
              }
            }
          }

          // The turn-boundary sibling. The server expands a tool_reference
          // into <functions>…</functions> — the same tag family the system
          // prompt's tool block uses — and with that expansion sitting at
          // the prompt TAIL, models measurably over-sample the stop
          // sequence (the recorded A/B on the base lineage: ~10% of runs
          // vs 0 with the fix). Appending one sibling text block gives the
          // prompt a clean turn boundary after the expansion.
          // Mechanics that make it safe:
          //  · injected at API-prep only, never stored — the REPL never
          //    renders it;
          //  · a SIBLING block, never inside tool_result.content — text
          //    mixed with tool_reference inside a block is a server
          //    ValueError;
          //  · startsWith-guarded, so the pass is idempotent when its own
          //    output cycles back through on the next request;
          //  · moot automatically when the strips above removed every
          //    tool_reference.
          // Unconditional since the cut: this was the gate-OFF arm, and
          // the mercury_toolref_defer_j8m gate that would have swapped in
          // the relocation pass is structurally false in this build.
          {
            const contentAfterStrip = normalizedMessage.message.content
            if (
              Array.isArray(contentAfterStrip) &&
              !contentAfterStrip.some(
                b =>
                  b.type === 'text' &&
                  b.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY),
              ) &&
              contentHasToolReference(contentAfterStrip)
            ) {
              normalizedMessage = {
                ...normalizedMessage,
                message: {
                  ...normalizedMessage.message,
                  content: [
                    ...contentAfterStrip,
                    { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY },
                  ],
                },
              }
            }
          }

          // The coalescing rule from the case header.
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(
              lastMessage,
              normalizedMessage,
            )
            return
          }

          result.push(normalizedMessage)
          return
        }
        case 'assistant': {
          // tool_use projection: inputs run through the tool's own API
          // normalizer (which drops storage-only fields like ExitPlanModeV2's
          // plan body), and with tool search OFF the tool_search-only
          // 'caller' field must not reach the wire either.
          const toolSearchEnabled = isToolSearchEnabledOptimistic()
          const normalizedMessage: AssistantMessage = {
            ...message,
            message: {
              ...message.message,
              // The shape owner: a resumed/foreign turn can carry a string
              // here — coerced once at the wire door, never a bare .map.
              content: (contentBlocksOf(message.message.content) as ContentBlock[]).map(block => {
                if (block.type === 'tool_use') {
                  const tool = tools.find(t => toolMatchesName(t, block.name))
                  const normalizedInput = tool
                    ? normalizeToolInputForAPI(
                        tool,
                        block.input as Record<string, unknown>,
                      )
                    : block.input
                  const canonicalName = tool?.name ?? block.name

                  // Beta ON: every stored field (caller included) is legal.
                  if (toolSearchEnabled) {
                    return {
                      ...block,
                      name: canonicalName,
                      input: normalizedInput,
                    }
                  }

                  // Beta OFF: rebuild from the standard fields only — a
                  // session stored during a tool-search run may carry
                  // fields that are illegal now.
                  return {
                    type: 'tool_use' as const,
                    id: block.id,
                    name: canonicalName,
                    input: normalizedInput,
                  }
                }
                return block
              }),
            },
          }

          // Same-id assistant chunks merge into one message. The search
          // walks BACKWARDS past tool results and other-id assistants:
          // concurrent agents interleave streamed chunks from different API
          // responses, so the matching id is not necessarily adjacent.
          for (let i = result.length - 1; i >= 0; i--) {
            const msg = result[i]!

            if (msg.type !== 'assistant' && !isToolResultMessage(msg)) {
              break
            }

            if (msg.type === 'assistant') {
              if (msg.message.id === normalizedMessage.message.id) {
                result[i] = mergeAssistantMessages(msg, normalizedMessage)
                return
              }
              continue
            }
          }

          result.push(normalizedMessage)
          return
        }
        case 'attachment': {
          // (The gated ensureSystemReminderWrap pass was deleted in the T18
          // cut — production-dead behind mercury_chair_sermon.)
          const attachmentMessage = normalizeAttachmentForAPI(
            message.attachment,
          )

          // Attachment-projected user messages coalesce like any others.
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = attachmentMessage.reduce(
              (p, c) => mergeUserMessagesAndToolResults(p, c),
              lastMessage,
            )
            return
          }

          result.push(...attachmentMessage)
          return
        }
      }
    })

  // (The gated relocateToolReferenceSiblings post-pass was deleted in the
  // cut; the TOOL_REFERENCE_TURN_BOUNDARY injection above is the live
  // arm of the turn-boundary fix.)

  // Orphaned thinking-only assistants go first — compaction can slice away
  // everything between a failed stream and its retry, leaving a bare
  // thinking message whose signature does not match its neighbor (an
  // API 400).
  const withFilteredOrphans = filterOrphanedThinkingOnlyMessages(result)

  // Pass ORDER is load-bearing: trailing thinking strips BEFORE the
  // whitespace-only filter. Reversed, [text("\n\n"), thinking(…)] slips the
  // whitespace filter (a non-text block is present), then loses its
  // thinking block — and the surviving [text("\n\n")] is an API reject.
  //
  // The multi-pass shape is inherently fragile — every pass can mint the
  // condition an EARLIER pass was supposed to clear. A future cut could
  // unify into one clean-then-validate pass; until then, order is contract.
  const withFilteredThinking =
    filterTrailingThinkingFromLastAssistant(withFilteredOrphans)
  const withFilteredWhitespace =
    filterWhitespaceOnlyAssistantMessages(withFilteredThinking)
  const withNonEmpty = ensureNonEmptyAssistantContent(withFilteredWhitespace)

  // (The gated final smooshSystemReminderSiblings(mergeAdjacentUserMessages)
  // pass was deleted in the cut — production-dead behind
  // mercury_chair_sermon; running the merge ungated would change VCR fixture
  // hashes for @-mention scenarios, so the gate-OFF arm is the behavior.)

  // Runs unconditionally: transcripts persisted before smooshIntoToolResult
  // filtered on is_error can still carry an image inside an error
  // tool_result — resumed unrepaired, such a session 400s on every request
  // forever.
  const sanitized = sanitizeErrorToolResultContent(withNonEmpty)

  // Image size validation is the last gate before the wire.
  validateImagesForAPI(sanitized)

  return sanitized
}

// Merging + API-bound filters live in owned submodules.


// Inbound normalization: repair the block-level quirks API responses carry
// (stringified streaming inputs, empty text) so a stored response can ride
// back OUT on a later request without erroring.
export function normalizeContentFromAPI(
  contentBlocks: ApiMessage['content'],
  tools: Tools,
  agentId?: AgentId,
): ApiMessage['content'] {
  if (!contentBlocks) {
    return []
  }
  // A null/undefined element (a hole in foreign-decoded JSON, a gateway
  // padding a content array) carries nothing decodable: it is dropped with
  // a log, never dereferenced — `contentBlock.type` on a hole was the raw
  // "reading 'type'" TypeError class this seam must never throw.
  if (contentBlocks.some(b => b == null)) {
    logForDebugging(
      'normalizeContentFromAPI: dropping null content block(s) from a provider response — not a decodable block shape',
      { level: 'warn' },
    )
    contentBlocks = contentBlocks.filter(b => b != null)
  }
  return contentBlocks.map(contentBlock => {
    switch (contentBlock.type) {
      case 'tool_use': {
        if (
          typeof contentBlock.input !== 'string' &&
          !isObject(contentBlock.input)
        ) {
          // Streaming delivers inputs as strings; the non-streaming
          // fallback delivers objects. Anything else is a malformed block.
          throw new Error('Tool use input must be a string or object')
        }

        // A string input is fine-grained-streamed JSON — parse it. An
        // unparseable non-empty string degrades to {} (downstream
        // validation then sees empty input and reports on ITS terms); an
        // empty string is the documented empty-input shape and also
        // becomes {}. Note the API can nest stringified JSON inside
        // parsed fields — only the top level is repaired here.
        let normalizedInput: unknown
        if (typeof contentBlock.input === 'string') {
          const parsed = safeParseJSON(contentBlock.input)
          if (parsed === null && contentBlock.input.length > 0) {
            // Parse failure on real content: record it locally — a silent
            // {} here surfaces later as a baffling "missing required
            // field" tool error with no cause attached.
            logForDebugging(
              `normalizeContentFromAPI: streamed tool_use input for ${contentBlock.name} failed to parse (${contentBlock.input.length} chars); using empty input`,
              { level: 'error' },
            )
          }
          normalizedInput = parsed ?? {}
        } else {
          normalizedInput = contentBlock.input
        }

        // Tool-specific input corrections ride after the parse repair.
        if (typeof normalizedInput === 'object' && normalizedInput !== null) {
          const tool = findToolByName(tools, contentBlock.name)
          if (tool) {
            try {
              normalizedInput = normalizeToolInput(
                tool,
                normalizedInput as { [key: string]: unknown },
                agentId,
              )
            } catch (error) {
              logError(new Error('Error normalizing tool input: ' + error))
              // A failed correction keeps the uncorrected input — better a
              // raw input than none.
            }
          }
        }

        return {
          ...contentBlock,
          input: normalizedInput,
        }
      }
      case 'text':
        // Byte-exact pass-through — altering text here would shift prompt-
        // cache bytes on the next request. Empty text blocks are a display-
        // layer concern, not a wire repair.
        return contentBlock
      case 'code_execution_tool_result':
      case 'mcp_tool_use':
      case 'mcp_tool_result':
      case 'container_upload':
        // Beta block shapes: pass through untouched.
        return contentBlock
      case 'server_tool_use':
        if (typeof contentBlock.input === 'string') {
          return {
            ...contentBlock,
            input: (safeParseJSON(contentBlock.input) ?? {}) as {
              [key: string]: unknown
            },
          }
        }
        return contentBlock
      default:
        return contentBlock
    }
  })
}

// Stream-event fan-out lives in the owned streaming submodule.

