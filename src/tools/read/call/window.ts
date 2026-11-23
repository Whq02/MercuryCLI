import { countTokensWithAPI, roughTokenCountEstimationForFileType } from '../../../models/facts/tokenEstimation.js'
import type { ReadFileRangeResult } from '../../../platform/files/readFileInRange.js'
import { planReadThrough } from '../../edit/readThrough.js'
import type { FileReadingLimits } from './fileReadLimits.js'
import { RESULT_ROOM_WRAPPER_TOKENS } from '../../../engine/run/resultRoom.js'
import { MAX_LINES_TO_READ } from '../../kit/names/fileRead.js'
import type { OverCapNote } from './schema.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export { MAX_DISPLAY_LINE_CHARS, cutMark, numberedReadContent, numberedWindow, overCapNextWords, overCapWords, windowSpan } from './windowText.js'

export class MaxFileReadTokenExceededError extends Error {
  readonly tokenCount: number
  readonly maxTokens: number
  readonly next: OverCapNote['next'] | undefined

  constructor(tokenCount: number, maxTokens: number, words: string, next?: OverCapNote['next']) {
    super(`File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}): ${words}`)
    this.name = 'MaxFileReadTokenExceededError'
    this.tokenCount = tokenCount
    this.maxTokens = maxTokens
    this.next = next
  }
}

export function firstWindowUnderCap(
  whole: ReadFileRangeResult,
  shownCount: number,
  totalLines: number,
  rendered: string,
  lineOffset: number,
  resolvedPath: string,
  ext: string,
  limits: FileReadingLimits,
  tokenCount: number,
): { shown: ReadFileRangeResult; note: OverCapNote } | null {
  const rough = roughTokenCountEstimationForFileType(rendered, ext)
  const density = rough > 0 ? Math.max(1, tokenCount / rough) : 1
  const allowance = Math.max(
    1,
    Math.floor(limits.maxTokens / density) - (limits.room === true ? RESULT_ROOM_WRAPPER_TOKENS : 0),
  )
  const startLine = lineOffset + 1
  const plan = planReadThrough(
    rendered,
    [{ start: startLine, end: lineOffset + shownCount }],
    resolvedPath,
    { maxLines: MAX_LINES_TO_READ, maxTokens: allowance },
    startLine,
  )
  const window = plan.windows[0]
  if (window === undefined || window.start !== startLine) return null
  const count = window.end - window.start + 1
  if (count >= shownCount) return null
  const content = whole.content.split('\n').slice(0, count).join('\n')
  const shown: ReadFileRangeResult = {
    ...whole,
    content,
    lineCount: count,
    readBytes: Buffer.byteLength(content, 'utf8'),
  }
  const remaining = Math.max(1, totalLines - window.end)
  const note: OverCapNote = {
    tokens: tokenCount,
    maxTokens: limits.maxTokens,
    next: {
      offset: window.end + 1,
      limit: Math.min(count, remaining),
    },
    ...(limits.room === true ? { room: true as const } : {}),
  }
  return { shown, note }
}

export async function tokensOverCap(content: string, ext: string, maxTokens: number, exact = true): Promise<number | undefined> {
  const estimate = roughTokenCountEstimationForFileType(content, ext)
  if (!estimate || estimate <= maxTokens / 4) return undefined
  let effective = estimate
  try {
    const accurate = exact ? await countTokensWithAPI(content) : null
    if (accurate !== null) effective = accurate
  } catch (error) {
    passedOver(error)
  }
  return effective > maxTokens ? effective : undefined
}
