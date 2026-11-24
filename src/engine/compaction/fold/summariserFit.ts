import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { Message } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import { appendSystemContext, toolToAPISchema } from '../../messages/apiSystemAndToolSchema.js'
import { roughTokenCountEstimation } from '../../../models/facts/tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { getBlockingLimit, getEffectiveContextWindowSize, resolveAutoFoldWindow } from '../../compaction-window/autoFoldWindow.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../tool-dispatch/toolResultStorage.js'
import { groupMessagesByApiRound } from '../groupByApiRound.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { fitToolResultImages } from '../../message-shapes/imageRequestFit.js'
import { PTL_RETRY_LIMIT, SUMMARISER_WINDOW_SHARE, SUMMARISER_BUDGET_FLOOR_TOKENS, SHAPED_RESULTS_KEEP_TOKENS, SHAPED_RESULT_PREVIEW_CHARS } from './foldLimits.js'
import { isPtlMarkerMessage, isFoldCapsuleMessage, stripImagesFromMessages } from './summariserInput.js'
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
  const model = context.options.engineModel
  const system = appendSystemContext(cacheSafeParams.systemPrompt ?? [], cacheSafeParams.systemContext ?? {}, model)
  const systemLength = JSON.stringify(system).length
  const tools = context.options.tools
  let toolsLength: number
  try {
    const getToolPermissionContext = async () => context.getAppState().toolPermissionContext
    const agents = context.options.agentDefinitions?.activeAgents ?? []
    const allowedAgentTypes = context.options.agentDefinitions?.allowedAgentTypes
    const schemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext,
          tools,
          agents,
          allowedAgentTypes,
          model,
        }),
      ),
    )
    toolsLength = JSON.stringify(schemas).length
  } catch {
    toolsLength = tools.length * SHAPED_RESULT_PREVIEW_CHARS
  }
  return Math.ceil((systemLength + toolsLength) / 4)
}

export async function summariserFitFor(
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  gauge: ReturnType<typeof readRequestGauge>,
): Promise<SummariserFit> {
  const model = context.options.engineModel
  const { window } = resolveAutoFoldWindow(model)
  const reserveTokens = Math.max(0, window - getEffectiveContextWindowSize(model))
  const blockingLimit = getBlockingLimit(model)
  const fixedTokens = gauge?.fixed.tokens ?? await estimateFixedRequestTokens(context, cacheSafeParams)
  const promptTokens = roughTokenCountEstimation(promptText)
  const driftSafe = Math.floor(window * SUMMARISER_WINDOW_SHARE) - reserveTokens
  const budgetTokens = Math.max(
    SUMMARISER_BUDGET_FLOOR_TOKENS,
    Math.min(blockingLimit, driftSafe) - fixedTokens - promptTokens,
  )
  const limitTokens = Math.max(budgetTokens, blockingLimit - fixedTokens - promptTokens)
  const ratio = gauge?.density.ratio ?? 1
  return { budgetTokens, limitTokens, fixedTokens, promptTokens, reserveTokens, window, blockingLimit, ratio }
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
    const workingOf = (group: Message[]): Message[] => group.filter(message => !isFoldCapsuleMessage(message))
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
    current = [...head.filter(isFoldCapsuleMessage), capsule, ...groups.slice(take).flat()]
  }
  return current
}

function capOlderToolResults(messages: Message[]): Message[] {
  let keptTokens = 0
  let overflowing = false
  const replacements = new Map<number, Map<number, string>>()
  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const message = messages[msgIndex]
    if (message?.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex]
      if (block === undefined || block.type !== 'tool_result') continue
      const text = resultTextOf(block.content)
      if (text === null) continue
      if (
        text.includes(FOLDED_RESULT_KEY) ||
        text.includes(PERSISTED_OUTPUT_TAG) ||
        text.includes(TOOL_RESULT_CLEARED_MESSAGE)
      ) {
        continue
      }
      const estTokens = Math.ceil(text.length / 4)
      if (!overflowing && keptTokens + estTokens <= SHAPED_RESULTS_KEEP_TOKENS) {
        keptTokens += estTokens
        continue
      }
      overflowing = true
      if (text.length <= SHAPED_RESULT_PREVIEW_CHARS) continue
      let perMessage = replacements.get(msgIndex)
      if (perMessage === undefined) {
        perMessage = new Map<number, string>()
        replacements.set(msgIndex, perMessage)
      }
      perMessage.set(blockIndex, shapedResultPreview(text, SHAPED_RESULT_PREVIEW_CHARS))
    }
  }
  if (replacements.size === 0) return messages
  return messages.map((message, msgIndex) => {
    const perMessage = replacements.get(msgIndex)
    if (perMessage === undefined || message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    const content = message.message.content.map((block, blockIndex) => {
      const preview = perMessage.get(blockIndex)
      if (preview === undefined || block.type !== 'tool_result') return block
      return { ...block, content: preview }
    })
    return { ...message, message: { ...message.message, content } }
  })
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
  const model = context.options.engineModel
  const measure = (rows: Message[]): number =>
    Math.ceil(
      estimateRequestGauge(
        rows,
        { digest: '', tokens: 0 },
        { ratio: fit.ratio, samples: 0, residuals: [] },
        model,
      ),
    )

  const whole = measure(messages)
  if (whole <= fit.budgetTokens) {
    return { input: messages, shaped: false }
  }
  const sayPrefitted = (stage: string, tokens: number): void => {
    logForDebugging(
      `compact: the summariser's input is pre-fitted — ${stage}: ≈${tokens} tokens against a budget of ${fit.budgetTokens} (window ${fit.window}, blocking limit ${fit.blockingLimit}, fixed material ≈${fit.fixedTokens}, the whole conversation ≈${whole})`,
    )
  }

  const fitted = fitToolResultImages(messages, rows => measure(rows) <= fit.budgetTokens).messages
  if (measure(fitted) <= fit.budgetTokens) {
    return { input: fitted, shaped: false }
  }

  let rows: Message[] = split !== null ? split.retiring : messages
  const withoutTail = measure(rows)
  if (withoutTail <= fit.budgetTokens) {
    sayPrefitted(`the kept tail (${split?.rounds ?? 0} rounds) split off`, withoutTail)
    return { input: rows, shaped: true }
  }

  rows = capOlderToolResults(stripImagesFromMessages(stripThinkingFromIndex(rows, 0)))
  const capped = measure(rows)
  if (capped <= fit.budgetTokens) {
    sayPrefitted('older tool results capped, thinking and media stripped', capped)
    return { input: rows, shaped: true }
  }

  rows = await foldOldestIntoParts(rows, fit.budgetTokens, measure, cacheSafeParams, promptText, context, ladder)
  sayPrefitted('the oldest rounds folded into part capsules', measure(rows))
  return { input: rows, shaped: true }
}
