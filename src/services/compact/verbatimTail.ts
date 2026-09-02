import type { Message } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  isMercurySubstrateProfileOn,
} from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { groupMessagesByApiRound } from './grouping.js'

/**
 * Verbatim recent-tail preservation for full autocompact ("Less Context, Better
 * Agents", arXiv:2606.10209 — keep the last ~N tool-call/response rounds VERBATIM
 * and summarize the older tail, vs. summarize-everything-and-keep-nothing). On a
 * long active run Mercury's context is shaped SOLELY by autocompact (cached-MC is
 * DCE'd off; time-based MC only fires after a >60-min idle gap) — and today full
 * autocompact (compactConversation) folds EVERYTHING into a model summary and keeps
 * ZERO verbatim tail (only ≤5 recently-read files are re-injected). That loses the
 * recent reasoning / command outputs / edits, which is exactly the "agent gets
 * dumber after a compaction" failure on long runs. This module preserves the most
 * recent whole API-rounds across the boundary, reusing the proven preservedSegment
 * relink (annotateBoundaryWithPreservedSegment) that partial /compact already uses.
 *
 * ADDITIVE / PROTECTIVE: it only ever ADDS retained context (capped) — it never
 * summarizes earlier or drops anything the summary wouldn't already cover (the
 * summary still covers the whole conversation; the tail is preserved on TOP of it).
 * That is why it is safe to ride the substrate profile default-ON for Mercury,
 * unlike the advance-TRIGGER (which forces an EARLY summary and is the silent-
 * forgetting vector, so it stays explicit opt-in — see autoCompact.ts). This
 * feature is the cure for that vector, not an instance of it.
 *
 * LOADABILITY: bun:bundle/feature()-FREE (like microCompactDigest.ts) so the proof
 * imports it directly under plain `bun run`. The token estimate is inlined (~4
 * chars/token) for the same reason; it only gates the budget cap, so coarse is fine.
 *
 * DEFAULT-ON for Mercury (cache-aware-compaction substrate), explicit opt-out
 * MERCURY_COMPACT_KEEP_TAIL=0. OFF ⇒ computeVerbatimRecentTail is never called and
 * compactConversation keeps no tail ⇒ byte-identical to today.
 */

/** Most-recent whole API-rounds to preserve verbatim across an autocompact. */
export const DEFAULT_KEEP_ROUNDS = 6

/**
 * Token budget for the preserved tail. Oldest whole kept rounds are dropped until
 * the tail fits. Sized well under POST_COMPACT_TOKEN_BUDGET (50K file-restore) so
 * tail + restored-files + skills can't immediately re-trigger compaction (the
 * rapid-refill breaker is the backstop). A single most-recent round is always kept
 * even if it alone exceeds this soft budget — one round of recent verbatim context
 * is the floor — UP TO the hard ceiling below.
 */
export const DEFAULT_TAIL_TOKEN_BUDGET = 15_000

/**
 * HARD ceiling on the single floor round. The soft budget above is dropped-to one
 * round at a time, but the floor (most-recent whole round) is kept even past the
 * soft budget. A whole round, though, is byte-UNBOUNDED: one round can carry a
 * single huge tool_result (a 150K-token file read / grep dump). Re-injecting that
 * verbatim across the boundary would defeat the compaction it rides on — post-compact
 * tokens would stay near the limit and immediately re-trigger (thrash) on a long run.
 * So when even the floor round exceeds this ceiling, we SKIP the tail entirely and
 * fall back to summary-only for that compaction. This is provably safe: the summary
 * still covers the whole conversation (the ADDITIVE invariant) — we forgo only the
 * verbatim bonus for one pathological round, never any data. Set under the 50K
 * post-compact file budget so tail + restored-files + summary stay comfortably bounded.
 */
export const MAX_FLOOR_ROUND_TOKENS = DEFAULT_TAIL_TOKEN_BUDGET * 2

/**
 * Minimum rounds that must exist BEYOND the kept tail for preservation to be worth
 * it — there must be a substantial summarized head, else keeping a tail is pointless
 * (nothing meaningful is being compacted) and we behave exactly as today.
 */
export const MIN_HEAD_ROUNDS = 2

/**
 * Gate: default-ON under the cache-aware-compaction substrate (the same
 * umbrella as the suppress-only breaker), honoring an explicit opt-in even when the
 * profile is off, and an explicit `=0` opt-out that always wins. OFF (
 * MERCURY_SUBSTRATE=0 with the env unset, or MERCURY_COMPACT_KEEP_TAIL=0) ⇒ no tail.
 */
export function isMercuryCompactKeepTailEnabled(): boolean {
  
  const flag = flagEnv('MERCURY_COMPACT_KEEP_TAIL')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false // explicit opt-out
  if (isEnvTruthy(flag)) return true // explicit opt-in
  return (
    isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION')) || isMercurySubstrateProfileOn()
  )
}

export type VerbatimTailResult = {
  /**
   * Contiguous suffix of `messages` to preserve verbatim, with non-API-loggable
   * messages (progress) and chain-confusing markers (old compact boundaries /
   * summaries) filtered out — exactly what partial /compact 'up_to' keeps.
   */
  keep: Message[]
  /**
   * uuid of the last loggable message that precedes keep[0] in `messages` — the
   * boundary's logicalParent (it sits between the summarized head and the tail).
   */
  precedingUuid: Message['uuid'] | undefined
  /** Whole rounds kept after the budget cap (telemetry / proof). */
  roundsKept: number
}

/** A message that should NOT be carried into the post-compact kept tail. */
function isNonPreservableTailMessage(m: Message): boolean {
  if (m.type === 'progress') return true
  if (
    m.type === 'system' &&
    (m as { subtype?: string }).subtype === 'compact_boundary'
  ) {
    return true
  }
  if (
    m.type === 'user' &&
    (m as { isCompactSummary?: boolean }).isCompactSummary === true
  ) {
    return true
  }
  return false
}

/**
 * Flat token cost for an image/document block — mirrors roughTokenCountEstimationForBlock
 * (tokenEstimation.ts). The block holds the full base64 source in the record (~1.33M chars
 * for a 1MB file ⇒ ~330K chars/4 estimate) but the API charges only ~2000. Counting its
 * bytes would falsely trip the floor-round ceiling and DROP the screenshot/PDF the user
 * just added — the context most worth preserving. Inlined (not imported) to keep this
 * module bun-run loadable for the proof.
 */
const IMAGE_DOC_BLOCK_TOKENS = 2000

/** Coarse ~4-chars/token estimate over a message's content. Inlined for loadability. */
function estimateMessageTokens(m: Message): number {
  const msg = (m as { message?: { content?: unknown } }).message
  const content = msg?.content
  if (content === undefined) {
    // System/progress/etc. — estimate from the whole record, small either way.
    try {
      return Math.ceil(JSON.stringify(m).length / 4)
    } catch {
      return 0
    }
  }
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (Array.isArray(content)) {
    // Per-block so a base64 image/document doesn't dominate the byte estimate. A
    // tool_result may itself nest image/document blocks (e.g. a Read of an image),
    // so account those at the flat rate too.
    let n = 0
    for (const block of content as Array<{ type?: string; content?: unknown }>) {
      const t = block?.type
      if (t === 'image' || t === 'document') {
        n += IMAGE_DOC_BLOCK_TOKENS
        continue
      }
      if (t === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content as Array<{ type?: string }>) {
          if (inner?.type === 'image' || inner?.type === 'document') {
            n += IMAGE_DOC_BLOCK_TOKENS
          } else {
            try {
              n += Math.ceil(JSON.stringify(inner).length / 4)
            } catch {
              /* skip unserializable */
            }
          }
        }
        continue
      }
      try {
        n += Math.ceil(JSON.stringify(block).length / 4)
      } catch {
        /* skip unserializable */
      }
    }
    return n
  }
  try {
    return Math.ceil(JSON.stringify(content).length / 4)
  } catch {
    return 0
  }
}

function estimateRoundTokens(group: Message[]): number {
  let n = 0
  for (const m of group) n += estimateMessageTokens(m)
  return n
}

/**
 * Compute the verbatim recent-tail to preserve across a full autocompact. PURE.
 * Returns null when preservation should be skipped (too few rounds, or nothing
 * preservable) — the caller then behaves exactly as today (summarize all, keep none).
 *
 * Whole API-rounds are kept (groupMessagesByApiRound boundaries are API-safe split
 * points — every tool_use is resolved before the next assistant turn) so the kept
 * tail never contains an orphaned tool_result.
 */
export function computeVerbatimRecentTail(
  messages: Message[],
  opts?: { keepRounds?: number; tailTokenBudget?: number },
): VerbatimTailResult | null {
  const keepRounds = Math.max(1, opts?.keepRounds ?? DEFAULT_KEEP_ROUNDS)
  const budget = Math.max(0, opts?.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET)

  const groups = groupMessagesByApiRound(messages)
  // Require a substantial summarized head beyond the kept tail; otherwise there is
  // nothing meaningful to compact and we should not pay the tail's redundancy.
  if (groups.length < keepRounds + MIN_HEAD_ROUNDS) return null

  // Last `keepRounds` whole rounds.
  let tailGroups = groups.slice(-keepRounds)

  // Budget cap: drop OLDEST whole kept rounds until under the soft budget. Always
  // keep at least the single most-recent round (the floor — one round of recent
  // verbatim context beats none).
  while (
    tailGroups.length > 1 &&
    tailGroups.reduce((s, g) => s + estimateRoundTokens(g), 0) > budget
  ) {
    tailGroups = tailGroups.slice(1)
  }

  // A whole round is byte-UNBOUNDED (a single giant tool_result lives in one round),
  // so the floor can blow past the soft budget. If even the lone most-recent round
  // exceeds the HARD ceiling, re-injecting it verbatim would defeat the compaction
  // it rides on (thrash). Skip the tail entirely and fall back to summary-only — the
  // summary still covers everything (ADDITIVE invariant), so no data is lost.
  if (
    tailGroups.length === 1 &&
    estimateRoundTokens(tailGroups[0]!) > MAX_FLOOR_ROUND_TOKENS
  ) {
    return null
  }

  const keep = tailGroups.flat().filter(m => !isNonPreservableTailMessage(m))
  if (keep.length === 0) return null

  // precedingUuid = last loggable (non-progress) message before keep[0].
  const firstKeptIdx = messages.findIndex(m => m.uuid === keep[0]!.uuid)
  let precedingUuid: Message['uuid'] | undefined
  for (let j = firstKeptIdx - 1; j >= 0; j--) {
    const prev = messages[j]
    if (prev && prev.type !== 'progress') {
      precedingUuid = prev.uuid
      break
    }
  }

  return { keep, precedingUuid, roundsKept: tailGroups.length }
}
