// providers/anthropic/cacheAndUsage — the exactly-one-marker cache_control placement
// (KV-page economics: see addCacheBreakpoints), cached-microcompact edit
// insertion, system-prompt block assembly, stream teardown, and the two
// usage folds (per-stream update, cross-turn accumulate). Mercury-owned
// the R6 parity oracle pins the
// marker contract in both directions.

import {
  type BetaMessageParam as MessageParam,
  type BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { type TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { type Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { type QuerySource } from 'src/constants/querySource.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  type AssistantMessage,
  type UserMessage,
} from '../../../types/message.js'
import type { ApiMessageDeltaUsage, ApiUsage } from '../../../types/wire.js'
import { splitSysPromptPrefix } from '../../../utils/api.js'
import { insertBlockAfterToolResults } from '../../../utils/contentArray.js'
import { type SystemPrompt } from '../../../utils/systemPromptType.js'
import { pinCacheEdits } from '../../compact/microCompact.js'
import { type NonNullableUsage } from '../../api/logging.js'
import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from './messageParams.js'
import { getCacheControl } from './requestParams.js'

/**
 * Tear a stream down without letting teardown itself throw: abort the
 * controller if it hasn't been already, swallow the already-closed case.
 * @internal Exported for testing
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // already closed — teardown must never throw
  }
}

/**
 * Fold one streaming usage part into the running total. The wire sends
 * CUMULATIVE totals, not deltas — so this replaces, never adds.
 *
 * The input-side fields (input_tokens and both cache counters) arrive real
 * in message_start and then reappear as explicit 0 in message_delta; the
 * `> 0` guard keeps a delta's zero from erasing the start's truth.
 * Output tokens genuinely grow, so nullish-coalescing suffices there.
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: ApiMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // The delta-usage SDK type omits cache_creation; the wire sends it.
      ephemeral_1h_input_tokens:
        (partUsage as ApiUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as ApiUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // Deliberately untracked: the cache-editing deletion counter the API
    // returns is not a NonNullableUsage member, which keeps its field name
    // out of external bundles entirely (dead-code elimination).
    inference_geo: usage.inference_geo,
    iterations:
      (partUsage.iterations as NonNullableUsage['iterations']) ??
      usage.iterations,
    speed: (partUsage as ApiUsage).speed ?? usage.speed,
    output_tokens_details:
      (partUsage as ApiUsage).output_tokens_details ??
      usage.output_tokens_details,
  }
}

/**
 * Fold one settled message's usage into a running cross-turn total: token
 * counters add; qualitative fields (tier, geo, iterations, speed, output
 * detail) take the newest message's word.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // (Same deliberate omission as updateUsage — see the note there.)
    inference_geo: messageUsage.inference_geo,
    iterations: messageUsage.iterations,
    speed: messageUsage.speed,
    output_tokens_details: messageUsage.output_tokens_details,
  }
}

export function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

export type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

export type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// Export is test-reachable: the placement provers drive this directly.
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  // ONE message-level cache_control marker per request — this is KV-page
  // economics, not style. Inference's turn-boundary eviction frees
  // local-attention pages at every cached prefix position it is not told to
  // protect; a second marker protects the second-to-last position for a
  // full extra turn even though nothing resumes from there. One marker ⇒
  // those pages free immediately.
  //
  // Fire-and-forget forks (skipCacheWrite) move the marker back one, to the
  // last SHARED prefix point: the cache write becomes a no-op merge on an
  // entry that already exists, so the fork leaves no private tail in the
  // cache. Dense pages are refcounted and survive under the new hash
  // regardless.
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  //  leaf boundary: Mercury-typed converter output enters the SDK
  // request vocabulary right here — the one cast for the conversation truth.
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  }) as unknown as MessageParam[]

  if (!useCachedMC) {
    return result
  }

  // A cache_reference may be deleted at most once per request, across every
  // edits block — pinned and new alike share this seen-set.
  const seenDeleteRefs = new Set<string>()
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // Previously-pinned edits replay at their recorded positions, so the
  // request the server sees is stable turn over turn.
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // Fresh edits land in the LAST user message and are pinned there, so the
  // next request replays them at the same index via the loop above.
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // Stamp cache_reference onto tool_results inside the cached prefix. Runs
  // AFTER edit insertion — splicing shifts content arrays, and the stamp
  // pass must see final indices.
  if (enablePromptCaching) {
    // Locate the last message holding a cache_control marker.
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // The API accepts cache_reference up to and including the marker
    // message; stamping strictly BEFORE it sidesteps the index-shift edge
    // cases that cache_edits splicing creates inside that boundary message.
    //
    // Copy-on-stamp: these blocks are shared with secondary queries whose
    // models may lack cache-editing support — mutating in place would leak
    // the field into their requests.
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

/**
 * Assemble the system-prompt block array: the prefix split decides block
 * boundaries and per-block cache scope; caching adds cache_control to every
 * block whose scope is non-null. Block count is a server-validated budget —
 * adding cached blocks beyond the split's output is a 400.
 */
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}
