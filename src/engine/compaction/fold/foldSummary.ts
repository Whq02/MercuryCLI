import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { AssistantMessage, Message } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import type { CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import type { OverflowSignal } from '../../requests/overflowSignal.js'
import { estimateRequestGauge, type readRequestGauge } from '../../run/requestGauge.js'
import { computeVerbatimRecentTail, isMercuryFoldKeepTailEnabled } from '../verbatimTail.js'
import { SPLIT_STAND_IN_FLOOR_TOKENS, SPLIT_STAND_IN_LANDING_SHARE } from './foldLimits.js'
import { validateSummary } from './summaryCheck.js'
import { newFoldLadder, foldLadderExhausted, proseSkippedNote, proseSkippedLine, summarizeWithPtlRetry } from './ladder.js'
import { summariserFitFor, prefitSummariserInput } from './summariserFit.js'

export type FitsUnder = (limit: number | undefined, resultsFolded: boolean, prose: string, memoryNote: string | null) => (keep: Message[]) => boolean

type SummaryNeeds = {
  messages: Message[]
  context: ToolUseContext
  summaryContext: ToolUseContext
  summaryCacheSafeParams: CacheSafeParams
  promptText: string
  gauge: ReturnType<typeof readRequestGauge>
  overflow?: OverflowSignal
  preFoldTokenCount: number
  landing?: number
  ceiling?: number
  fitsUnder: FitsUnder
}

export async function summariseForFold({
  messages,
  context,
  summaryContext,
  summaryCacheSafeParams,
  promptText,
  gauge,
  overflow,
  preFoldTokenCount,
  landing,
  ceiling,
  fitsUnder,
}: SummaryNeeds): Promise<{
  splitRounds: number
  response: AssistantMessage | undefined
  rawSummary: string
  proseSkipped: string | undefined
  proseSkippedReceipt: string | undefined
}> {
  const fit = await summariserFitFor(summaryContext, summaryCacheSafeParams, promptText, gauge)
  const ladder = newFoldLadder(fit.budgetTokens)
  const requestTokens = estimateRequestGauge(
    messages,
    { digest: '', tokens: 0 },
    { ratio: fit.ratio, samples: 0, residuals: [] },
    summaryContext.options.engineModel,
  )

  let splitRounds = 0
  let response: AssistantMessage | undefined
  let rawSummary = ''
  let proseSkipped: string | undefined
  let proseSkippedReceipt: string | undefined

  try {
    let summaryInput = messages
    if (
      overflow !== undefined ||
      preFoldTokenCount + fit.promptTokens > fit.blockingLimit ||
      requestTokens > fit.limitTokens
    ) {
      let split: { retiring: Message[]; rounds: number } | null = null
      if (isMercuryFoldKeepTailEnabled()) {
        const standInTokens = Math.min(
          fit.reserveTokens,
          Math.max(
            SPLIT_STAND_IN_FLOOR_TOKENS,
            Math.floor((landing ?? fit.reserveTokens) / SPLIT_STAND_IN_LANDING_SHARE),
          ),
        )
        const standInProse = 'summary '.repeat(Math.ceil(standInTokens / 2))
        const probes: ReadonlyArray<[number | undefined, boolean]> = [
          [landing, false],
          [ceiling, false],
          [landing, true],
          [ceiling, true],
        ]
        for (const [limit, resultsFolded] of probes) {
          try {
            const tail = computeVerbatimRecentTail(messages, {
              fits: fitsUnder(limit, resultsFolded, standInProse, null),
            })
            if (tail !== null && tail.keep.length > 0) {
              const firstKeptIndex = messages.findIndex(row => row.uuid === tail.keep[0]!.uuid)
              if (firstKeptIndex > 0) {
                split = { retiring: messages.slice(0, firstKeptIndex), rounds: tail.roundsKept }
              }
            }
            break
          } catch (error) {
            passedOver(error)
          }
        }
      }
      const prefitted = await prefitSummariserInput(
        messages,
        fit,
        split,
        summaryCacheSafeParams,
        promptText,
        summaryContext,
        ladder,
      )
      summaryInput = prefitted.input
      if (prefitted.shaped && split !== null) {
        splitRounds = split.rounds
      }
    }

    response = await summarizeWithPtlRetry(
      summaryInput,
      summaryCacheSafeParams,
      promptText,
      summaryContext,
      ladder,
    )
    rawSummary = validateSummary(response, true)
  } catch (err) {
    if (!foldLadderExhausted(err) || context.abortController.signal.aborted) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    proseSkipped = proseSkippedLine(message)
    proseSkippedReceipt = proseSkippedNote(message)
    response = undefined
    rawSummary = ''
    logForDebugging(`compact: the ladder's bottom — ${message}; the fold lands on Mercury's own records without a prose summary`, { level: 'warn' })
  }

  return { splitRounds, response, rawSummary, proseSkipped, proseSkippedReceipt }
}
