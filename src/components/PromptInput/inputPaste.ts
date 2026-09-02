// Pure over-long-input truncation into a referenced paste entry.
// Threshold 10,000 characters; the kept prefix and suffix are 500 each; the
// removed middle becomes a text paste entry and a truncated-text chip is
// spliced in. The chip format is contract data, parsed by the shared
// reference parser: `[...Truncated text #N +M lines...]`; its line count
// comes from the same helper the pasted-text form uses (S24's history).

import type { PastedContent } from '../../utils/config.js'
import { getPastedTextRefNumLines } from '../../history.js'

const TRUNCATE_THRESHOLD = 10_000
const KEEP_EACH_SIDE = 500

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`
}

/** Pure; returns the text unchanged with an empty placeholder when at or
 *  under the threshold. */
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

/** Pure; returns the inputs unchanged when nothing was truncated. The
 *  created entry carries its id, the text kind, and the removed middle. */
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
