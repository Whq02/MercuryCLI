import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import { createUserMessage, getAssistantMessageText } from '../../messages/messages.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE, getPromptTooLongTokenGap } from '../../requests/apiErrorRows.js'
import { overflowGapTokens, overflowSignalOf } from '../../requests/overflowSignal.js'
import { groupMessagesByApiRound } from '../groupByApiRound.js'
import { estimateContextTokens } from '../pruneToolResults.js'
import { ERROR_MESSAGE_PROMPT_TOO_LONG, PTL_RETRY_LIMIT, NO_SUMMARY_RETRY_LIMIT, ERROR_MESSAGE_NO_SUMMARY, PROSE_SKIPPED_KEY, PART_SUMMARY_MARKER, PART_TEXT_CHUNK_CHARS, PART_TEXT_CHUNK_FLOOR_CHARS } from './foldLimits.js'
import { isPtlMarkerMessage, isFoldCapsuleMessage } from './summariserInput.js'
import { runSummarization } from './summarise.js'
import { summaryAnswerFault, validateSummary } from './summaryCheck.js'

function summaryRefused(response: AssistantMessage): boolean {
  const text = getAssistantMessageText(response) ?? ''
  return text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) || overflowSignalOf(response) !== null
}

function overflowGapOf(response: AssistantMessage): number | undefined {
  const signal = overflowSignalOf(response)
  return getPromptTooLongTokenGap(response) ?? (signal !== null ? overflowGapTokens(signal) : undefined)
}

export type FoldLadder = { noSummaryRetries: number; budgetTokens?: number }

export function newFoldLadder(budgetTokens?: number): FoldLadder {
  return { noSummaryRetries: 0, ...(budgetTokens !== undefined ? { budgetTokens } : {}) }
}

export function foldLadderExhausted(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.startsWith(ERROR_MESSAGE_PROMPT_TOO_LONG) || error.message.startsWith(ERROR_MESSAGE_NO_SUMMARY)
}

function overflowExhaustedWords(gap: number | undefined): string {
  return `the last part sent was refused over the window${gap !== undefined && gap > 0 ? ` by ${gap.toLocaleString('en-US')} tokens` : ''}`
}

export function proseSkippedNote(cause: string): string {
  const why = cause.startsWith(`${ERROR_MESSAGE_NO_SUMMARY}: `)
    ? cause.slice(ERROR_MESSAGE_NO_SUMMARY.length + 2)
    : cause.startsWith(ERROR_MESSAGE_PROMPT_TOO_LONG)
      ? `the summariser was refused as too long even for its smallest part${cause.slice(ERROR_MESSAGE_PROMPT_TOO_LONG.length).trim() === '' ? '' : ` (${cause.slice(ERROR_MESSAGE_PROMPT_TOO_LONG.length).trim().replace(/^\(|\)$/g, '')})`}`
      : cause
  return `${PROSE_SKIPPED_KEY}: ${why}.`
}

export function proseSkippedLine(cause: string): string {
  return `${proseSkippedNote(cause)} The earlier stretch is preserved in the records below.`
}

export function isPartSummaryMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const user = message as UserMessage
  return user.isMeta === true && typeof user.message.content === 'string' && user.message.content.startsWith(PART_SUMMARY_MARKER)
}

export function partCapsule(summary: string): UserMessage {
  return createUserMessage({ content: `${PART_SUMMARY_MARKER}\n\n${summary}`, isMeta: true })
}

function messageAsText(message: Message): string {
  if (message.type !== 'user' && message.type !== 'assistant') return ''
  const content = (message as UserMessage | AssistantMessage).message.content
  if (typeof content === 'string') return `${message.type}: ${content}`
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[tool call ${String(block.name)}] ${JSON.stringify(block.input)}`)
    else if (block.type === 'tool_result') {
      const inner = block.content
      const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : ''
      parts.push(`[tool result] ${text}`)
    } else if (block.type === 'image' || block.type === 'document') parts.push(`[${String(block.type)} omitted]`)
  }
  return `${message.type}: ${parts.join('\n')}`
}

export function splitTextForFold(text: string, chunkChars: number): string[] {
  const chunks: string[] = []
  for (let at = 0; at < text.length; at += chunkChars) chunks.push(text.slice(at, at + chunkChars))
  return chunks.length === 0 ? [''] : chunks
}

function partChunkChars(ladder: FoldLadder): number {
  if (ladder.budgetTokens === undefined) return PART_TEXT_CHUNK_CHARS
  return Math.min(PART_TEXT_CHUNK_CHARS, Math.max(PART_TEXT_CHUNK_FLOOR_CHARS, ladder.budgetTokens * 4))
}

async function summarizeTextInParts(
  text: string,
  chunkChars: number,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<string | null> {
  const summaries: string[] = []
  for (const chunk of splitTextForFold(text, chunkChars)) {
    const response = await runSummarization([createUserMessage({ content: chunk })], cacheSafeParams, createUserMessage({ content: promptText }), context, ladder.noSummaryRetries > 0)
    if (!summaryRefused(response) && summaryAnswerFault(response) === null) {
      summaries.push(validateSummary(response, false))
      continue
    }
    if (!summaryRefused(response) && ++ladder.noSummaryRetries > NO_SUMMARY_RETRY_LIMIT) return null
    if (chunkChars <= PART_TEXT_CHUNK_FLOOR_CHARS) return null
    const narrowerChars = Math.max(PART_TEXT_CHUNK_FLOOR_CHARS, Math.floor(chunkChars / 2))
    if (chunk.length <= narrowerChars) return null
    const narrower = await summarizeTextInParts(chunk, narrowerChars, cacheSafeParams, promptText, context, ladder)
    if (narrower === null) return null
    summaries.push(narrower)
  }
  return summaries.join('\n\n')
}

export async function foldAllAsText(
  input: Message[],
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[] | null> {
  const working = input.filter(message => !isFoldCapsuleMessage(message))
  if (working.length === 0) return null
  const text = working.map(messageAsText).filter(line => line !== '').join('\n\n')
  const summary = await summarizeTextInParts(text, partChunkChars(ladder), cacheSafeParams, promptText, context, ladder)
  if (summary === null) return null
  const capsule = partCapsule(summary)
  if (estimateContextTokens([capsule]) >= estimateContextTokens(working)) return null
  return [...input.filter(isFoldCapsuleMessage), capsule]
}

async function foldHeadIntoCapsule(
  messages: Message[],
  gap: number | undefined,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[] | null> {
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  const workingOf = (rows: Message[]): Message[] => rows.filter(message => !isFoldCapsuleMessage(message))
  const sizeOf = (rows: Message[]): number => estimateContextTokens(workingOf(rows))
  if (groups.length >= 2) {
    const ahead = groups.slice(0, groups.length - 1).flat()
    const coverable = gap === undefined || sizeOf(ahead) >= gap
    if (coverable && workingOf(ahead).length > 0) {
      let dropCount: number
      if (gap !== undefined) {
        dropCount = 0
        let freed = 0
        while (dropCount < groups.length - 1 && freed < gap) {
          freed += sizeOf(groups[dropCount] as Message[])
          dropCount++
        }
      } else {
        dropCount = Math.ceil(groups.length / 2)
      }
      dropCount = Math.max(1, Math.min(dropCount, groups.length - 1))
      while (dropCount < groups.length - 1 && workingOf(groups.slice(0, dropCount).flat()).length === 0) dropCount++
      const head = groups.slice(0, dropCount).flat()
      const working = workingOf(head)
      if (working.length > 0) {
        const partResponse = await summarizeWithPtlRetry(working, cacheSafeParams, promptText, context, ladder)
        const capsule = partCapsule(validateSummary(partResponse, false))
        return [...head.filter(isFoldCapsuleMessage), capsule, ...groups.slice(dropCount).flat()]
      }
    }
  }
  return foldAllAsText(input, cacheSafeParams, promptText, context, ladder)
}

export async function summarizeWithPtlRetry(
  initialMessages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder = newFoldLadder(),
): Promise<AssistantMessage> {
  let messages = initialMessages
  let before = estimateContextTokens(messages)
  const bound = groupMessagesByApiRound(messages).length + PTL_RETRY_LIMIT
  let fault: string | null = null
  let lastGap: number | undefined
  for (let attempt = 0; attempt <= bound; attempt++) {
    if (attempt > 0) context.onFoldProgress?.({ type: 'retry', attempt: attempt + 1 })
    const promptMessage = createUserMessage({ content: promptText })
    const response = await runSummarization(messages, cacheSafeParams, promptMessage, context, ladder.noSummaryRetries > 0)
    let folded: Message[] | null
    if (summaryRefused(response)) {
      fault = null
      lastGap = overflowGapOf(response)
      if (attempt === bound) break
      folded = await foldHeadIntoCapsule(messages, lastGap, cacheSafeParams, promptText, context, ladder)
    } else {
      fault = summaryAnswerFault(response)
      if (fault === null) return response
      if (ladder.noSummaryRetries >= NO_SUMMARY_RETRY_LIMIT || attempt === bound) break
      ladder.noSummaryRetries++
      logForDebugging(`compact: ${fault} — retrying on half the input with thinking and effort unchanged (retry ${ladder.noSummaryRetries} of ${NO_SUMMARY_RETRY_LIMIT})`, { level: 'warn' })
      folded = await foldHeadIntoCapsule(messages, undefined, cacheSafeParams, promptText, context, ladder)
    }
    if (folded === null) break
    const after = estimateContextTokens(folded)
    if (after >= before && groupMessagesByApiRound(folded).length >= groupMessagesByApiRound(messages).length) break
    before = after
    messages = folded
  }
  throw new Error(fault === null ? `${ERROR_MESSAGE_PROMPT_TOO_LONG} (${overflowExhaustedWords(lastGap)})` : `${ERROR_MESSAGE_NO_SUMMARY}: ${fault}`)
}
