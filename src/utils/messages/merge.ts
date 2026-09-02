// Message merging — the Bedrock-compatible user/assistant turn coalescing and
// the tool_result smoosh machinery (the anti-"Human: at a bare tail" fixes,
// see #21049 lineage in the function docs). The parity oracle (scripts/messages) pins behavior.

import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import last from 'lodash-es/last.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { isToolReferenceBlock } from '../toolSearch.js'

export function normalizeUserTextContent(
  a: string | ContentBlockParam[],
): ContentBlockParam[] {
  return typeof a === 'string' ? [{ type: 'text', text: a }] : a
}

/** tool_result blocks must lead a user message's content — "tool result must
 * follow tool use" API errors otherwise. */
export function hoistToolResults(
  content: ContentBlockParam[],
): ContentBlockParam[] {
  const toolResults: ContentBlockParam[] = []
  const otherBlocks: ContentBlockParam[] = []
  for (const block of content) {
    if (block.type === 'tool_result') toolResults.push(block)
    else otherBlocks.push(block)
  }
  return [...toolResults, ...otherBlocks]
}

/**
 * Concatenate two content arrays, appending `\n` to a's trailing text block at
 * a text-text seam (the API joins adjacent text blocks with NO separator —
 * queued prompts "2 + 2" + "3 + 3" would otherwise read "2 + 23 + 3").
 * The `\n` stays on a's side so no block's startsWith changes (historically
 * the gated system-reminder smoosh discriminated on
 * startsWith('<system-reminder>'); the placement is pinned by the parity
 * goldens either way).
 */
export function joinTextAtSeam(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

type ToolResultContentItem = Extract<
  ToolResultBlockParam['content'],
  readonly unknown[]
>[number]

/**
 * Fold blocks into a tool_result's content. Returns the updated tool_result,
 * or null when the smoosh is impossible (tool_reference cannot mix with other
 * content — server ValueError).
 *
 * - is_error results accept only text (API constraint); non-text blocks are
 *   dropped from the smoosh (they arrive as a proper user turn anyway)
 * - string/undefined content + all-text blocks → string (legacy shape)
 * - otherwise → array with adjacent text merged
 */
export function smooshIntoToolResult(
  tr: ToolResultBlockParam,
  blocks: ContentBlockParam[],
): ToolResultBlockParam | null {
  if (blocks.length === 0) return tr

  const existing = tr.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) {
    return null
  }

  if (tr.is_error) {
    blocks = blocks.filter(b => b.type === 'text')
    if (blocks.length === 0) return tr
  }

  const allText = blocks.every(b => b.type === 'text')
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const joined = [
      (existing ?? '').trim(),
      ...blocks.map(b => (b as TextBlockParam).text.trim()),
    ]
      .filter(Boolean)
      .join('\n\n')
    return { ...tr, content: joined }
  }

  const base: ToolResultContentItem[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? existing.trim()
          ? [{ type: 'text', text: existing.trim() }]
          : []
        : [...existing]

  const merged: ToolResultContentItem[] = []
  for (const b of [...base, ...blocks]) {
    if (b.type === 'text') {
      const t = b.text.trim()
      if (!t) continue
      const prev = merged.at(-1)
      if (prev?.type === 'text') {
        merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${t}` } // lvalue
      } else {
        merged.push({ type: 'text', text: t })
      }
    } else {
      // image / search_result / document — pass through
      merged.push(b as ToolResultContentItem)
    }
  }
  return { ...tr, content: merged }
}

/** Merge b's blocks after a's, smooshing all-text siblings into a's trailing
 * string-content tool_result (the legacy string-only smoosh — the one live
 * arm; the gated "universal smoosh" family was deleted in the cut, see
 * below). */
export function mergeUserContentBlocks(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  // Any sibling after tool_result renders as </function_results>\n\nHuman:<…>
  // on the wire; repeated mid-conversation it teaches the model to emit
  // Human: at a bare tail (#21049 lineage). The string-content + all-text
  // smoosh below is the live mitigation.
  //
  // DELETION RECORD: the gated
  // "universal smoosh" family — the mercury_chair_sermon arm here, plus
  // ensureSystemReminderWrap / smooshSystemReminderSiblings /
  // mergeAdjacentUserMessages / the pairing re-smoosh /
  // relocateToolReferenceSiblings (apiView) — was production-dead: the owned
  // FEATURE_GATE_TABLE = {} (featureGates.ts) pins mercury_chair_sermon and
  // mercury_toolref_defer_j8m structurally false (env + config ladders are
  // dead code). The arms encoded an A/B-validated improvement ("Human: at a
  // bare tail" → 0%); resurrecting it is a git revert of this cut, armed by
  // pinning the gates in FEATURE_GATE_TABLE. prove-message-model-contract.ts
  // §DORMANT-GATE pins today's truth.
  const lastBlock = last(a)
  if (lastBlock?.type !== 'tool_result') {
    return [...a, ...b]
  }
  if (
    typeof lastBlock.content === 'string' &&
    b.every(x => x.type === 'text')
  ) {
    const copy = a.slice()
    copy[copy.length - 1] = smooshIntoToolResult(lastBlock, b)!
    return copy
  }
  return [...a, ...b]
}

export function mergeUserMessagesAndToolResults(
  a: UserMessage,
  b: UserMessage,
): UserMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: hoistToolResults(
        mergeUserContentBlocks(
          normalizeUserTextContent(a.message.content),
          normalizeUserTextContent(b.message.content),
        ),
      ),
    },
  }
}

export function mergeAssistantMessages(
  a: AssistantMessage,
  b: AssistantMessage,
): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [...a.message.content, ...b.message.content],
    },
  }
}

export function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  if (typeof content === 'string') return false
  return content.some(block => block.type === 'tool_result')
}

export function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  return {
    ...a,
    // Keep the non-meta side's uuid so [id:] tags (uuid-derived) stay stable
    // across API calls (meta messages get fresh uuids every call).
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: hoistToolResults(
        joinTextAtSeam(
          normalizeUserTextContent(a.message.content),
          normalizeUserTextContent(b.message.content),
        ),
      ),
    },
  }
}

// (mergeAdjacentUserMessages / ensureSystemReminderWrap /
// smooshSystemReminderSiblings — the gated final-pass smoosh family — were
// deleted in the cut; see the deletion record on mergeUserContentBlocks.)
