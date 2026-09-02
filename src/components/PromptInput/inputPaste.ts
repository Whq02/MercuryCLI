
import type { PastedContent } from '../../utils/config.js'
import { getPastedTextRefNumLines } from '../../history.js'

const TRUNCATE_THRESHOLD = 10_000
const KEEP_EACH_SIDE = 500

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`
}

export function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number,
): { truncatedText: string; placeholderContent: string } {
  if (text.length <= TRUNCATE_THRESHOLD) {
    return { truncatedText: text, placeholderContent: '' }
  }
  const head = text.slice(0, KEEP_EACH_SIDE)
  const tail = text.slice(-KEEP_EACH_SIDE)
  const middle = text.slice(KEEP_EACH_SIDE, -KEEP_EACH_SIDE)
  const chip = formatTruncatedTextRef(
    nextPasteId,
    getPastedTextRefNumLines(middle),
  )
  return { truncatedText: `${head}${chip}${tail}`, placeholderContent: middle }
}

export function maybeTruncateInput(
  text: string,
  pastes: Record<number, PastedContent>,
): {
  newInput: string
  newPastedContents: Record<number, PastedContent>
} {
  const ids = Object.keys(pastes).map(Number)
  const nextId = ids.length > 0 ? Math.max(...ids) + 1 : 1
  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(
    text,
    nextId,
  )
  if (placeholderContent === '') {
    return { newInput: text, newPastedContents: pastes }
  }
  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastes,
      [nextId]: { id: nextId, type: 'text', content: placeholderContent },
    },
  }
}
