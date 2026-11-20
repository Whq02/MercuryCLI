import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import { appendSystemContext, toolToAPISchema } from '../../../utils/api.js'
import { roughTokenCountEstimation } from '../../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { getBlockingLimit, getEffectiveContextWindowSize, resolveAutoCompactWindow } from '../autoCompactWindow.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../../utils/toolResultStorage.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'
import { fitToolResultImages } from '../../../utils/messages/imageRequestFit.js'
import { PTL_RETRY_LIMIT, SUMMARISER_WINDOW_SHARE, SUMMARISER_BUDGET_FLOOR_TOKENS, SHAPED_RESULTS_KEEP_TOKENS, SHAPED_RESULT_PREVIEW_CHARS } from './limits.js'
import { isPtlMarkerMessage, isCompactCapsuleMessage, stripImagesFromMessages } from './input.js'
import { validateSummary } from './summaryCheck.js'
import { type FoldLadder, partCapsule, foldAllAsText, summarizeWithPtlRetry } from './ladder.js'

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
  const system = JSON.stringify(appendSystemContext([...cacheSafeParams.systemPrompt], cacheSafeParams.systemContext ?? {}, context.options.engineModel))
  let tools = 0
  try {
    const schemas = await Promise.all(
      context.options.tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: () => Promise.resolve(context.getAppState().toolPermissionContext),
          tools: context.options.tools,
          agents: context.options.agentDefinitions.activeAgents,
          allowedAgentTypes: context.options.agentDefinitions.allowedAgentTypes,
          model: context.options.engineModel,
        }),
      ),
    )
    tools = JSON.stringify(schemas).length
  } catch {
    tools = context.options.tools.length * SHAPED_RESULT_PREVIEW_CHARS
  }
  return Math.ceil((system.length + tools) / 4)
}

export async function summariserFitFor(
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  gauge: ReturnType<typeof readRequestGauge>,
): Promise<SummariserFit> {
  const model = context.options.engineModel
  const window = resolveAutoCompactWindow(model).window
  const reserveTokens = Math.max(0, window - getEffectiveContextWindowSize(model))
  const blockingLimit = getBlockingLimit(model)
  const fixedTokens = gauge?.fixed.tokens ?? (await estimateFixedRequestTokens(context, cacheSafeParams))
  const promptTokens = roughTokenCountEstimation(promptText)
  const driftSafe = Math.floor(window * SUMMARISER_WINDOW_SHARE) - reserveTokens
  const budgetTokens = Math.max(SUMMARISER_BUDGET_FLOOR_TOKENS, Math.min(blockingLimit, driftSafe) - fixedTokens - promptTokens)
  const limitTokens = Math.max(budgetTokens, blockingLimit - fixedTokens - promptTokens)
  return { budgetTokens, limitTokens, fixedTokens, promptTokens, reserveTokens, window, blockingLimit, ratio: gauge?.density.ratio ?? 1 }
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

function capOlderToolResults(rows: Message[], keepTokens: number, previewChars: number): Message[] {
  const sizes: Array<{ row: number; block: number; text: string }> = []
  rows.forEach((row, index) => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return
    ;(row.message.content as Array<{ type?: string; content?: unknown }>).forEach((block, at) => {
      if (block.type !== 'tool_result') return
      const text = resultTextOf(block.content)
      if (text === null || text.length <= previewChars) return
      if (text.startsWith(FOLDED_RESULT_KEY) || text.startsWith(PERSISTED_OUTPUT_TAG) || text.startsWith(TOOL_RESULT_CLEARED_MESSAGE)) return
      sizes.push({ row: index, block: at, text })
    })
  })
  const capped = new Map<number, Map<number, string>>()
  let kept = 0
  for (let at = sizes.length - 1; at >= 0; at--) {
    const entry = sizes[at] as (typeof sizes)[number]
    const tokens = Math.ceil(entry.text.length / 4)
    if (kept + tokens <= keepTokens) {
      kept += tokens
      continue
    }
    const blocks = capped.get(entry.row) ?? new Map<number, string>()
    blocks.set(entry.block, shapedResultPreview(entry.text, previewChars))
    capped.set(entry.row, blocks)
  }
  if (capped.size === 0) return rows
  return rows.map((row, index) => {
    const blocks = capped.get(index)
    if (blocks === undefined || row.type !== 'user' || !Array.isArray(row.message.content)) return row
    return {
      ...row,
      message: {
        ...row.message,
        content: (row.message.content as Array<{ type?: string; content?: unknown }>).map((block, at) => (blocks.has(at) ? { ...block, content: blocks.get(at) } : block)),
      },
    } as Message
  })
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
  const measure = (rows: Message[]): number => Math.ceil(estimateRequestGauge(rows, { digest: '', tokens: 0 }, { ratio: fit.ratio, samples: 0, residuals: [] }, context.options.engineModel))
  const whole = measure(messages)
  if (whole <= fit.budgetTokens) return { input: messages, shaped: false }
  const imagesFitted = fitToolResultImages(messages, rows => measure(rows) <= fit.budgetTokens)
  if (measure(imagesFitted.messages) <= fit.budgetTokens) return { input: imagesFitted.messages, shaped: false }
  const say = (stage: string, rows: Message[]): void =>
    logForDebugging(`compact: the summariser's input is pre-fitted — ${stage}: ≈${measure(rows)} tokens against a budget of ${fit.budgetTokens} (window ${fit.window}, blocking limit ${fit.blockingLimit}, fixed material ≈${fit.fixedTokens}, the whole conversation ≈${whole})`)
  let rows = split === null ? messages : split.retiring
  if (measure(rows) <= fit.budgetTokens) {
    say(`the kept tail (${split?.rounds ?? 0} rounds) split off`, rows)
    return { input: rows, shaped: true }
  }
  rows = capOlderToolResults(stripImagesFromMessages(stripThinkingFromIndex(rows, 0)), SHAPED_RESULTS_KEEP_TOKENS, SHAPED_RESULT_PREVIEW_CHARS)
  if (measure(rows) <= fit.budgetTokens) {
    say('older tool results capped, thinking and media stripped', rows)
    return { input: rows, shaped: true }
  }
  rows = await foldOldestIntoParts(rows, fit.budgetTokens, measure, cacheSafeParams, promptText, context, ladder)
  say('the oldest rounds folded into part capsules', rows)
  return { input: rows, shaped: true }
}
