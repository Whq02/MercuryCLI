
import sliceAnsi from './sliceAnsi.js'
import { ctrlOToExpand } from '../components/CtrlOToExpand.js'

const VISIBLE_LINES = 3

const WIDTH_ALLOWANCE = 12

const MIN_WRAP_WIDTH = 10

export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint: boolean = false,
): string {
  const trimmedContent = content.replace(/\s+$/, '')
  if (trimmedContent === '') return ''

  const wrapWidth = Math.max(MIN_WRAP_WIDTH, terminalWidth - WIDTH_ALLOWANCE)

  const maxChars = VISIBLE_LINES * wrapWidth * 4
  const preTruncated = trimmedContent.length > maxChars
  const working = preTruncated ? sliceAnsi(trimmedContent, 0, maxChars) : trimmedContent

  const lines: string[] = []
  for (const raw of working.split('\n')) {
    if (raw.length === 0) {
      lines.push('')
      continue
    }
    let rest = raw
    while (rest.length > 0) {
      const chunk = sliceAnsi(rest, 0, wrapWidth)
      lines.push(chunk.replace(/\s+$/, ''))
      const after = sliceAnsi(rest, wrapWidth)
      if (after === rest) break
      rest = after
    }
  }

  const remainingLines = lines.length - VISIBLE_LINES

  if (!preTruncated && remainingLines === 1) {
    return lines.slice(0, VISIBLE_LINES + 1).join('\n')
  }
  if (!preTruncated && remainingLines <= 0) {
    return lines.join('\n')
  }

  const estimate = preTruncated
    ? Math.max(remainingLines, Math.ceil(trimmedContent.length / wrapWidth) - VISIBLE_LINES)
    : remainingLines
  const shown = lines.slice(0, VISIBLE_LINES)
  const hint = suppressExpandHint ? '' : ` ${ctrlOToExpand()}`
  const tail = `… +${preTruncated ? '~' : ''}${estimate} lines${hint}`
  return [...shown, tail].join('\n')
}

export function isOutputLineTruncated(content: string): boolean {
  let idx = -1
  for (let i = 0; i < 4; i++) {
    idx = content.indexOf('\n', idx + 1)
    if (idx === -1) return false
  }
  return idx < content.length - 1
}
