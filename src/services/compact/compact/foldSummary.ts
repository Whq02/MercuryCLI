import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import type { OverflowSignal } from '../../api/overflowSignal.js'
import { estimateRequestGauge, type readRequestGauge } from '../../run/requestGauge.js'
import { computeVerbatimRecentTail, isMercuryCompactKeepTailEnabled } from '../verbatimTail.js'
import { SPLIT_STAND_IN_FLOOR_TOKENS, SPLIT_STAND_IN_LANDING_SHARE } from './limits.js'
import { validateSummary } from './summaryCheck.js'
import { newFoldLadder, foldLadderExhausted, proseSkippedNote, proseSkippedLine, summarizeWithPtlRetry } from './ladder.js'
import { summariserFitFor, prefitSummariserInput } from './summariserFit.js'

export type FitsUnder = (limit: number | undefined, resultsFolded: boolean, prose: string, memoryNote: string | null) => (keep: Message[]) => boolean

interface SummaryNeeds {
  messages: Message[]
  context: ToolUseContext
  summaryContext: ToolUseContext
  summaryCacheSafeParams: CacheSafeParams
  promptText: string
  gauge: ReturnType<typeof readRequestGauge>
  overflow: OverflowSignal | undefined
  preCompactTokenCount: number
  landing: number | undefined
  ceiling: number | undefined
  fitsUnder: FitsUnder
}

export async function summariseForFold({ messages, context, summaryContext, summaryCacheSafeParams, promptText, gauge, overflow, preCompactTokenCount, landing, ceiling, fitsUnder }: SummaryNeeds): Promise<{ splitRounds: number; response: AssistantMessage | undefined; rawSummary: string; proseSkipped: string | undefined; proseSkippedReceipt: string | undefined }> {
  const fit = await summariserFitFor(summaryContext, summaryCacheSafeParams, promptText, gauge)
  const ladder = newFoldLadder(fit.budgetTokens)
  let splitRounds = 0
  let response: AssistantMessage | undefined
  let rawSummary = ''
  let proseSkipped: string | undefined
  let proseSkippedReceipt: string | undefined
  try {
    let summaryInput = messages
    const requestTokens = estimateRequestGauge(messages, { digest: '', tokens: 0 }, { ratio: fit.ratio, samples: 0, residuals: [] }, summaryContext.options.engineModel)
    if (overflow !== undefined || preCompactTokenCount + fit.promptTokens > fit.blockingLimit || requestTokens > fit.limitTokens) {
      let split: { retiring: Message[]; rounds: number } | null = null
      if (isMercuryCompactKeepTailEnabled()) {
        const standIn = 'summary '.repeat(Math.ceil(Math.min(fit.reserveTokens, Math.max(SPLIT_STAND_IN_FLOOR_TOKENS, Math.floor((landing ?? fit.reserveTokens) / SPLIT_STAND_IN_LANDING_SHARE))) / 2))
        for (const [limit, resultsFolded] of [[landing, false], [ceiling, false], [landing, true], [ceiling, true]] as const) {
          try {
            const tail = computeVerbatimRecentTail(messages, { fits: fitsUnder(limit, resultsFolded, standIn, null) })
            const first = tail === null || tail.keep.length === 0 ? -1 : messages.findIndex(row => row.uuid === tail.keep[0]?.uuid)
            if (tail !== null && first > 0) split = { retiring: messages.slice(0, first), rounds: tail.roundsKept }
            break
          } catch {
            split = null
          }
        }
      }
      const shaped = await prefitSummariserInput(messages, fit, split, summaryCacheSafeParams, promptText, summaryContext, ladder)
      summaryInput = shaped.input
      if (shaped.shaped && split !== null) splitRounds = split.rounds
    }
    response = await summarizeWithPtlRetry(summaryInput, summaryCacheSafeParams, promptText, summaryContext, ladder)
    rawSummary = validateSummary(response, true)
  } catch (error) {
    if (!foldLadderExhausted(error) || context.abortController.signal.aborted) throw error
    proseSkipped = proseSkippedLine((error as Error).message)
    proseSkippedReceipt = proseSkippedNote((error as Error).message)
    logForDebugging(`compact: the ladder's bottom — ${(error as Error).message}; the fold lands on Mercury's own records without a prose summary`, { level: 'warn' })
  }
  return { splitRounds, response, rawSummary, proseSkipped, proseSkippedReceipt }
}
