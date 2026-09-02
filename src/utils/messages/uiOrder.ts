// Transcript display ordering — the tool-turn grouping projection. Re-owned
// Mercury module (native-core; the R2 split body was
// base-derived ~70% verbatim). The behavior is doubly pinned: the parity
// oracle (scripts/messages) replays it over the fixture corpus, and
// scripts/core-runtime/prove-message-model-contract.ts §ORDER holds the
// differential + reference laws over seeded random corpora.
//
// THE CONTRACT (what the projection promises):
//   • Each tool use renders as one contiguous group at the position of its
//     tool_use message: use → PreToolUse hooks → result → PostToolUse hooks,
//     grouped members in input order.
//   • Standalone messages (everything not grouped) keep their relative order.
//   • Consecutive api_error banners collapse to the later one, and only the
//     TRAILING banner survives the projection at all.
//   • Synthetic streaming tool uses append at the end.
//   • This is a PROJECTION: no message is cloned — every output element is
//     an input element (the render layer memoizes on reference identity).
//   • CHARACTERIZED: a grouped member whose tool_use message is not in the
//     window (orphaned result / orphaned hook) drops from display; duplicate
//     tool_use ids emit their group once, at the first use position.

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

/** Total classification of a display message's role in the projection. */
type DisplayRole =
  | { kind: 'use'; toolUseID: string }
  /** isToolUseRequestMessage but no leading tool_use block (non-normalized
   *  input only) — drops from display, matching the base-era walk. */
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

/** Re-order so each tool result (and its hooks) renders right after its tool
 * use: tool use → pre-hooks → result → post-hooks. Standalone messages keep
 * their relative order; only the LAST api_error banner survives. */
export function reorderMessagesInUI(
  messages: DisplayMessage[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): DisplayMessage[] {
  // Pass 1: index the grouped members by tool_use id (use/result last-wins,
  // hooks accumulate in input order). Roles are classified ONCE and reused
  // by the projection pass.
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

  // Pass 2: project display order.
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
      // Grouped members were emitted at their use's position; an orphaned
      // member (no use in the window) drops — characterized above.
      case 'use-unkeyed':
      case 'pre-hook':
      case 'result':
      case 'post-hook':
        break
      case 'api-error': {
        // Consecutive banners collapse onto the later one.
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

  // Only the trailing api_error banner survives (identity, not equality —
  // the banner may also be the last synthetic).
  const last = result.at(-1)
  return result.filter(
    m => m.type !== 'system' || m.subtype !== 'api_error' || m === last,
  )
}
