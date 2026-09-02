// ============================================================================
//  src/services/providers/faultUsageEstimate.ts — the usage fact for a
//  request the provider billed but never metered (FN-018 rank 4).
//
//  On the OpenAI, compat and Z.AI lanes the wire emits usage only from a
//  COMPLETED response (the final chunk before [DONE], or the terminal
//  Responses event). A stream that faults after partial content — a
//  transport read failure, an idle timeout — settles with no usage frame:
//  the lanes minted the words that arrived, the turn machine injected its
//  bounded continuation (a SECOND billed request, metered normally), and
//  the faulted request joined the ledger at zero. Two billed requests
//  reported as one; /cost, the persisted cost row and the --max-budget gate
//  all under-read by the whole faulted request on a recovery road the tree
//  itself describes as measured-common.
//
//  The prompt side is knowable from the request that was sent, the output
//  side from the blocks that streamed — both through the ONE character-
//  ratio estimator every unmetered surface already falls back to. An
//  estimate in the ledger beats a silent zero; the streamCore abort
//  settlement (prove-ledger-every-exit) takes the same stance.
// ============================================================================
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import type { AssistantMessage } from '../../types/message.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import { logForDebugging } from '../../utils/debug.js'

/** The characters a settled block would send back as output. */
function streamedCharsOf(minted: ReadonlyArray<Pick<AssistantMessage, 'message'>>): number {
  let chars = 0
  for (const m of minted) {
    const content: unknown = m.message.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') chars += block.text.length
      if (typeof block.thinking === 'string') chars += block.thinking.length
      if (block.type === 'tool_use' && block.input !== undefined) chars += JSON.stringify(block.input).length
    }
  }
  return chars
}

/** The wire request's text, for the character estimate (the JSON envelope
 *  adds a little over the raw prompt — an estimate's ceiling, never a
 *  silent zero). */
function requestCharsOf(request: unknown): number {
  try {
    return JSON.stringify(request)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * The estimated usage of a faulted request: the request as SENT (input —
 * the wire body is in scope at every lane's settlement, the product
 * messages are not), the minted blocks (output); no cache counters —
 * nothing on these lanes reports a cache split for a request that never
 * completed.
 */
export function estimateFaultedRequestUsage(args: {
  lane: string
  model: string
  request: unknown
  minted: ReadonlyArray<Pick<AssistantMessage, 'message'>>
  faultCode: string
}): NonNullableUsage {
  const input = roughTokenCountEstimation(' '.repeat(requestCharsOf(args.request)))
  const output = roughTokenCountEstimation(' '.repeat(streamedCharsOf(args.minted)))
  logForDebugging(
    `[${args.lane}] the stream faulted after content (${args.faultCode}) with no usage frame — settling ${args.model} into the ledger at the character estimate (≈${input} in / ≈${output} out) rather than zero`,
  )
  return { ...EMPTY_USAGE, input_tokens: input, output_tokens: output }
}
