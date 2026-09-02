import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { AssistantMessage, Message } from '../types/message.js'
import type { ApiUsage } from '../types/wire.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from './messages.js'

/**
 * Context-window and usage accounting over the message history.
 */

type ContentBlockLike = {
  type?: string
  text?: string
  thinking?: string
  data?: string
  input?: unknown
}

/**
 * A usage record with no positive count in any of its four context fields
 * and no per-iteration list is the per-block streaming placeholder (every
 * engine lane mints its assistant records from an EMPTY_USAGE partial and
 * writes the wire's usage onto the LAST block only), never a wire fact: a
 * request always carries at least one input token. A server-tool-loop
 * record may carry its counts in `iterations` alone, so a non-empty list
 * keeps the record.
 */
function isPlaceholderUsage(usage: ApiUsage): boolean {
  const iterations = (usage as { iterations?: unknown }).iterations
  if (Array.isArray(iterations) && iterations.length > 0) return false
  return (
    (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) <=
    0
  )
}

/**
 * A message contributes usage only when it is an assistant message
 * carrying a non-placeholder usage record whose first content block is not
 * a known synthetic text and whose model is not the synthetic sentinel.
 */
export function getTokenUsage(message: Message | undefined): ApiUsage | undefined {
  if (!message || message.type !== 'assistant') return undefined
  const apiMessage = (message as AssistantMessage).message
  const usage = apiMessage?.usage
  if (!usage) return undefined
  const content = apiMessage.content
  const firstBlock = Array.isArray(content) ? (content[0] as ContentBlockLike | undefined) : undefined
  if (
    firstBlock?.type === 'text' &&
    typeof firstBlock.text === 'string' &&
    SYNTHETIC_MESSAGES.has(firstBlock.text)
  ) {
    return undefined
  }
  if (apiMessage.model === SYNTHETIC_MODEL) return undefined
  if (isPlaceholderUsage(usage as ApiUsage)) return undefined
  return usage as ApiUsage
}

/** Full context size: input + both cache families + output, absent cache fields counting as zero. */
export function getTokenCountFromUsage(usage: ApiUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/** The full total of the most recent usage-bearing message; zero when there is none. */
export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (usage) return getTokenCountFromUsage(usage)
  }
  return 0
}

/**
 * The context tokens the last response ended at. When the usage carries a
 * non-empty per-iteration list (server-side tool loops), the last
 * iteration's input+output wins; otherwise the top-level input+output.
 * BOTH branches exclude cache tokens, deliberately, so they agree with
 * each other — this value drives a remaining-budget computation that must
 * survive compaction boundaries.
 */
export function finalContextTokensFromLastResponse(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    const iterations = usage.iterations as Array<{ input_tokens?: number; output_tokens?: number }> | null
    if (Array.isArray(iterations) && iterations.length > 0) {
      const last = iterations[iterations.length - 1] as { input_tokens?: number; output_tokens?: number }
      return (last.input_tokens ?? 0) + (last.output_tokens ?? 0)
    }
    return usage.input_tokens + usage.output_tokens
  }
  return 0
}

/** The four-field usage of the most recent usage-bearing message, cache fields defaulted to zero; null when none. */
export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    }
  }
  return null
}

/** Strictly greater than 200k on the LAST assistant message's full total; false without one. */
export function doesMostRecentAssistantMessageExceed200k(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    const usage = getTokenUsage(message)
    if (!usage) return false
    return getTokenCountFromUsage(usage) > 200_000
  }
  return false
}

/**
 * Character count of assistant output for spinner token estimation
 * (roughly four characters per token). Signature deltas are excluded —
 * they are not model output.
 */
export function getAssistantMessageContentLength(message: AssistantMessage): number {
  const content = message.message.content
  if (!Array.isArray(content)) return 0
  let length = 0
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      length += block.text.length
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      length += block.thinking.length
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      length += block.data.length
    } else if (block.type === 'tool_use' && block.input !== undefined) {
      length += JSON.stringify(block.input).length
    }
  }
  return length
}

/** The context the next request carries, and where the number came from:
 *  `usage` — the last wire-reported usage plus an estimate of what landed
 *  after it; `estimate` — no usage-bearing response exists, so every record
 *  is character-ratio estimated (a surface labels this one). */
export type ContextFill = { tokens: number; source: 'usage' | 'estimate' }

/**
 * The compact-boundary usage fence: rows at or before the LAST compact
 * boundary described the folded-away history, and rows the fold RE-HOMED
 * across the boundary (the verbatim keep-tail — the boundary's
 * preservedSegment whose anchor is a summary row, never the boundary
 * itself) carry usage that counted the WHOLE dead conversation. Anchoring
 * the gauge on either reports the pre-fold weight over a folded context —
 * the very number the fold just retired — which re-trips the auto-compact
 * threshold every turn until the rapid-refill breaker kills the session.
 * Returns the index BELOW which (inclusive) usage anchors are dead, plus
 * the re-homed rows' uuids; null when no boundary rides the list.
 */
function compactUsageFence(
  messages: readonly Message[],
): { boundaryIndex: number; rehomedUuids: ReadonlySet<string> } | null {
  let boundaryIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; subtype?: string }
    if (message?.type === 'system' && message.subtype === 'compact_boundary') {
      boundaryIndex = index
      break
    }
  }
  if (boundaryIndex === -1) return null
  const boundary = messages[boundaryIndex] as {
    uuid?: string
    compactMetadata?: { preservedSegment?: { headUuid?: string; anchorUuid?: string; tailUuid?: string } }
  }
  const rehomed = new Set<string>()
  const segment = boundary.compactMetadata?.preservedSegment
  // anchorUuid === the boundary's own uuid marks the kept-PREFIX shape
  // (partial 'from'): those rows stand in place before the boundary and the
  // index rule already fences them. Any other anchor is the re-homed tail.
  if (segment?.headUuid !== undefined && segment.tailUuid !== undefined && segment.anchorUuid !== boundary.uuid) {
    let inside = false
    for (const message of messages) {
      const uuid = (message as { uuid?: string }).uuid
      if (uuid === segment.headUuid) inside = true
      if (inside && uuid !== undefined) rehomed.add(uuid)
      if (uuid === segment.tailUuid) break
    }
  }
  return { boundaryIndex, rehomedUuids: rehomed }
}

/**
 * The canonical context size for threshold checks (auto-compaction,
 * session memory) and every fill surface. Parallel tool calls stream as
 * one assistant record per content block, all sharing one response id and
 * one usage record, with tool results interleaved after their uses — so the
 * estimation anchors at the FIRST record sharing the last usage-bearing
 * record's response id, and everything after the anchor is estimated.
 * Anchoring at the last record would leave the interleaved tool results out
 * and under-count a context the next request carries in full.
 *
 * Sibling records of the usage-bearing response are counted exactly once:
 * a settled usage (the record carries a stop_reason — the wire's final
 * usage lands with it) already covers every block's output, so those
 * siblings are skipped by the estimate; an unsettled record (a
 * message_start snapshot mid-stream, output_tokens not yet final) keeps
 * them estimated so the in-flight output is never dropped.
 */
export function contextFill(messages: readonly Message[]): ContextFill {
  const fence = compactUsageFence(messages)
  let usageIndex = -1
  let usageTotal = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (fence !== null) {
      // The fold retired every usage fact at or before its boundary, and the
      // re-homed keep-tail's usage counted the dead history — dead anchors
      // both (see compactUsageFence). Without a live post-fold anchor the
      // whole projection estimates: honest and labeled.
      if (index <= fence.boundaryIndex) break
      const uuid = (messages[index] as { uuid?: string }).uuid
      if (uuid !== undefined && fence.rehomedUuids.has(uuid)) continue
    }
    const usage = getTokenUsage(messages[index])
    if (usage) {
      usageIndex = index
      usageTotal = getTokenCountFromUsage(usage)
      break
    }
  }
  if (usageIndex === -1) {
    return { tokens: roughTokenCountEstimationForMessages(messages as never), source: 'estimate' }
  }

  let anchor = usageIndex
  const usageMessage = (messages[usageIndex] as AssistantMessage).message
  const responseId = usageMessage.id
  const settled = usageMessage.stop_reason !== null && usageMessage.stop_reason !== undefined
  if (responseId) {
    for (let index = usageIndex - 1; index >= 0; index--) {
      const message = messages[index]
      const id =
        message?.type === 'assistant' ? (message as AssistantMessage).message?.id : undefined
      // Records with no response id (user, tool-result, attachment,
      // synthetic assistant) are transparent to the walk.
      if (id === undefined || id === null) continue
      if (id === responseId) {
        anchor = index
        continue
      }
      break
    }
  }
  const tail = messages.slice(anchor + 1).filter(message => {
    if (!settled || !responseId || message.type !== 'assistant') return true
    return (message as AssistantMessage).message?.id !== responseId
  })
  return { tokens: usageTotal + roughTokenCountEstimationForMessages(tail as never), source: 'usage' }
}

/** The canonical context size (contextFill's token figure). */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  return contextFill(messages).tokens
}
