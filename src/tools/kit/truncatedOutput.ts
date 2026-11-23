import sliceAnsi from '../../platform/text/sliceAnsi.js'
import { stringWidth } from '../../screen/renderer/stringWidth.js'
import { ctrlOToExpand } from '../../screen/messages/ctrlOToExpandHint.js'

const VISIBLE_LINES = 3

const WIDTH_ALLOWANCE = 12

const MIN_WRAP_WIDTH = 10

const PRE_LIMIT_MULTIPLIER = 12

function wrapLine(line: string, wrapWidth: number): string[] {
  const trimmedLine = line.trimEnd()
  const width = stringWidth(trimmedLine)
  if (width <= wrapWidth) return [trimmedLine]
  const chunks: string[] = []
  let offset = 0
  while (offset < width) {
    const chunk = sliceAnsi(trimmedLine, offset, offset + wrapWidth)
    const chunkWidth = stringWidth(chunk)
    chunks.push(chunk.trimEnd())
    offset += chunkWidth > 0 ? chunkWidth : wrapWidth
  }
  return chunks
}

export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint?: boolean,
): string {
  const trimmed = content.trimEnd()
  if (trimmed === '') return ''

  const wrapWidth = Math.max(MIN_WRAP_WIDTH, terminalWidth - WIDTH_ALLOWANCE)
  const preLimit = wrapWidth * PRE_LIMIT_MULTIPLIER
  const isPreLimited = trimmed.length > preLimit
  const input = isPreLimited ? trimmed.slice(0, preLimit) : trimmed

  const wrappedLines: string[] = []
  for (const line of input.split('\n')) {
    wrappedLines.push(...wrapLine(line, wrapWidth))
  }

  if (!isPreLimited && wrappedLines.length <= VISIBLE_LINES + 1) {
    return wrappedLines.join('\n')
  }

  const shown = wrappedLines.slice(0, VISIBLE_LINES)
  const omitted = isPreLimited
    ? Math.max(
        wrappedLines.length - VISIBLE_LINES,
        Math.ceil(trimmed.length / wrapWidth) - VISIBLE_LINES,
      )
    : wrappedLines.length - VISIBLE_LINES
  const countPrefix = isPreLimited ? '~' : ''
  const expandHint = suppressExpandHint ? '' : ` ${ctrlOToExpand()}`
  return [...shown, `… +${countPrefix}${omitted} lines${expandHint}`].join('\n')
}

export function isOutputLineTruncated(content: string): boolean {
  let pos = -1
  for (let i = 0; i < VISIBLE_LINES + 1; i++) {
    pos = content.indexOf('\n', pos + 1)
    if (pos === -1) return false
  }
  return pos < content.length - 1
}
