import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import { appendSystemContext, toolToAPISchema } from '../../messages/api.js'
import { roughTokenCountEstimation } from '../../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { getBlockingLimit, getEffectiveContextWindowSize, resolveAutoCompactWindow } from '../../../utils/compact/autoCompactWindow.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../../utils/toolResultStorage.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { fitToolResultImages } from '../../../utils/messages/imageRequestFit.js'
import { PTL_RETRY_LIMIT, SUMMARISER_WINDOW_SHARE, SUMMARISER_BUDGET_FLOOR_TOKENS, SHAPED_RESULTS_KEEP_TOKENS, SHAPED_RESULT_PREVIEW_CHARS } from './limits.js'
import { isPtlMarkerMessage, isCompactCapsuleMessage, stripImagesFromMessages } from './input.js'
import { validateSummary } from './summaryCheck.js'
import { type FoldLadder, partCapsule, foldAllAsText, summarizeWithPtlRetry } from './ladder.js'
import { notBuilt } from '../../../pi/holes.js'

type SummariserFit = {
  budgetTokens: number
  limitTokens: number
  fixedTokens: number
  promptTokens: number
  reserveTokens: number
  window: number
  blockingLimit: number
  ratio: number
}

export async function estimateFixedRequestTokens(context: ToolUseContext, cacheSafeParams: CacheSafeParams): Promise<number> {
  return notBuilt('src/services/compact/compact/summariserFit.ts:30')
}

export async function summariserFitFor(
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  gauge: ReturnType<typeof readRequestGauge>,
): Promise<SummariserFit> {
  return notBuilt('src/services/compact/compact/summariserFit.ts:52')
}

function resultTextOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type?: string; text?: string }>
  if (!blocks.every(block => block.type === 'text' && typeof block.text === 'string')) return null
  return blocks.map(block => block.text ?? '').join('\n')
}

function shapedResultPreview(text: string, previewChars: number): string {
  if (text.length <= previewChars) return text
  const headBudget = Math.floor(previewChars * 0.6)
  let head = text.slice(0, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = text.slice(text.length - (previewChars - headBudget))
  const tailNewline = tail.indexOf('\n')
  if (tailNewline !== -1 && tailNewline < tail.length / 2) tail = tail.slice(tailNewline + 1)
  const omitted = text.length - head.length - tail.length
  return `${head}\n… [${omitted.toLocaleString('en-US')} characters omitted for the compaction — the full result is in the transcript] …\n${tail}`
}

async function foldOldestIntoParts(
  rows: Message[],
  budgetTokens: number,
  measure: (rows: Message[]) => number,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[]> {
  let current = rows
  const passes = groupMessagesByApiRound(rows).length + PTL_RETRY_LIMIT
  for (let pass = 0; pass < passes; pass++) {
    if (measure(current) <= budgetTokens) return current
    const input = current.filter(message => !isPtlMarkerMessage(message))
    const groups = groupMessagesByApiRound(input)
    const workingOf = (group: Message[]): Message[] => group.filter(message => !isCompactCapsuleMessage(message))
    if (groups.length < 2) {
      const text = await foldAllAsText(input, cacheSafeParams, promptText, context, ladder)
      return text ?? current
    }
    let take = 0
    let size = 0
    while (take < groups.length - 1) {
      const next = measure(workingOf(groups[take] as Message[]))
      if (take > 0 && size + next > budgetTokens) break
      size += next
      take++
    }
    while (take < groups.length - 1 && workingOf(groups.slice(0, take).flat()).length === 0) take++
    const head = groups.slice(0, take).flat()
    const working = workingOf(head)
    if (working.length === 0) return current
    const partResponse = await summarizeWithPtlRetry(working, cacheSafeParams, promptText, context, ladder)
    const capsule = partCapsule(validateSummary(partResponse, false))
    current = [...head.filter(isCompactCapsuleMessage), capsule, ...groups.slice(take).flat()]
  }
  return current
}

export async function prefitSummariserInput(
  messages: Message[],
  fit: SummariserFit,
  split: { retiring: Message[]; rounds: number } | null,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<{ input: Message[]; shaped: boolean }> {
  return notBuilt('src/services/compact/compact/summariserFit.ts:169')
}
