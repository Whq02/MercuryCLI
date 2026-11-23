import type { PastedContent } from '../../utils/config.js'
import { getPastedTextRefNumLines } from '../../history.js'

const TRUNCATE_THRESHOLD = 10_000
const KEEP_EACH_SIDE = 500

export function maybeTruncateInput(
  text: string,
  pastes: Record<number, PastedContent>,
): {
  newInput: string
  newPastedContents: Record<number, PastedContent>
} {
  if (text.length <= TRUNCATE_THRESHOLD) {
    return { newInput: text, newPastedContents: pastes }
  }
  const numericKeys = Object.keys(pastes)
    .map(Number)
    .filter(Number.isFinite)
  const nextId = numericKeys.length === 0 ? 1 : Math.max(...numericKeys) + 1
  const head = text.slice(0, KEEP_EACH_SIDE)
  const middle = text.slice(KEEP_EACH_SIDE, text.length - KEEP_EACH_SIDE)
  const tail = text.slice(text.length - KEEP_EACH_SIDE)
  const numLines = getPastedTextRefNumLines(middle)
  const placeholder = `[...Truncated text #${nextId} +${numLines} lines...]`
  const newInput = `${head}${placeholder}${tail}`
  const newPastedContents: Record<number, PastedContent> = {
    ...pastes,
    [nextId]: {
      id: nextId,
      type: 'text',
      content: middle,
    },
  }
  return { newInput, newPastedContents }
}
