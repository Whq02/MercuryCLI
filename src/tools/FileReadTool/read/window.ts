import { countTokensWithAPI, roughTokenCountEstimationForFileType } from '../../../services/tokenEstimation.js'
import type { ReadFileRangeResult } from '../../../utils/readFileInRange.js'
import { planReadThrough } from '../../FileEditTool/readThrough.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import { RESULT_ROOM_WRAPPER_TOKENS } from '../../../services/run/resultRoom.js'
import { MAX_LINES_TO_READ } from '../../../constants/tools/fileRead.js'
import type { OverCapNote } from './schema.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

export { MAX_DISPLAY_LINE_CHARS, cutMark, numberedReadContent, numberedWindow, overCapNextWords, overCapWords, windowSpan } from './windowText.js'

export class MaxFileReadTokenExceededError extends Error {
  readonly tokenCount: number
  readonly maxTokens: number
  readonly next: OverCapNote['next'] | undefined

  constructor(tokenCount: number, maxTokens: number, words: string, next?: OverCapNote['next']) {
    notBuilt('src/tools/FileReadTool/read/window.ts:17')
    super(...(notBuilt('src/tools/FileReadTool/read/window.ts:17') as ConstructorParameters<typeof Error>))
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
  return notBuilt('src/tools/FileReadTool/read/window.ts:26')
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
