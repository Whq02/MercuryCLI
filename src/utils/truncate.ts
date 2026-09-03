import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'


const ELLIPSIS = '…'

function graphemes(text: string): string[] {
  const segments: string[] = []
  for (const segment of getGraphemeSegmenter().segment(text)) {
    segments.push(segment.segment)
  }
  return segments
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return ELLIPSIS
  let result = ''
  let width = 0
  for (const grapheme of graphemes(text)) {
    const graphemeWidth = stringWidth(grapheme)
    if (width + graphemeWidth > maxWidth - 1) break
    result += grapheme
    width += graphemeWidth
  }
  return result + ELLIPSIS
}

export function truncateStartToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return ELLIPSIS
  const parts = graphemes(text)
  let result = ''
  let width = 0
  for (let index = parts.length - 1; index >= 0; index--) {
    const grapheme = parts[index] as string
    const graphemeWidth = stringWidth(grapheme)
    if (width + graphemeWidth > maxWidth - 1) break
    result = grapheme + result
    width += graphemeWidth
  }
  return ELLIPSIS + result
}

export function truncateKeepingTail(text: string, maxWidth: number, keepTail?: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return ELLIPSIS
  const parts = graphemes(text)
  let tailStart = parts.length
  if (keepTail !== undefined) {
    let width = 0
    for (let index = parts.length - 1; index >= 0; index--) {
      const w = stringWidth(parts[index] as string)
      if (width + w > keepTail) break
      width += w
      tailStart = index
    }
  } else {
    const dash = text.lastIndexOf(' — ')
    if (dash !== -1) {
      const clauseAt = dash
      let seen = 0
      for (let index = 0; index < parts.length; index++) {
        if (seen >= clauseAt) {
          tailStart = index
          break
        }
        seen += (parts[index] as string).length
      }
    }
  }
  const tail = parts.slice(tailStart).join('')
  const tailWidth = stringWidth(tail)
  if (tailWidth + 1 >= maxWidth) return truncateStartToWidth(tail, maxWidth)
  const headBudget = maxWidth - tailWidth - 1
  let head = ''
  let width = 0
  for (const grapheme of parts.slice(0, tailStart)) {
    const graphemeWidth = stringWidth(grapheme)
    if (width + graphemeWidth > headBudget) break
    head += grapheme
    width += graphemeWidth
  }
  return `${head.trimEnd()}${ELLIPSIS}${tail}`
}

export function truncateToWidthNoEllipsis(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 0) return ''
  let result = ''
  let width = 0
  for (const grapheme of graphemes(text)) {
    const graphemeWidth = stringWidth(grapheme)
    if (width + graphemeWidth > maxWidth) break
    result += grapheme
    width += graphemeWidth
  }
  return result
}

export function truncatePathMiddle(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path
  if (maxLength <= 0) return ELLIPSIS
  if (maxLength < 5) return truncateToWidth(path, maxLength)

  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const filename = lastSlash === -1 ? path : path.slice(lastSlash)
  const directory = lastSlash === -1 ? '' : path.slice(0, lastSlash)
  const filenameWidth = stringWidth(filename)

  if (filenameWidth >= maxLength - 1) {
    return truncateStartToWidth(path, maxLength)
  }
  const directoryBudget = maxLength - 1 - filenameWidth
  const truncatedDirectory = truncateToWidthNoEllipsis(directory, directoryBudget)
  return truncatedDirectory + ELLIPSIS + filename
}

export function truncate(str: string, maxWidth: number, singleLine: boolean = false): string {
  if (singleLine && str.includes('\n')) {
    const firstLine = str.slice(0, str.indexOf('\n'))
    if (stringWidth(firstLine) + 1 > maxWidth) {
      return truncateToWidth(firstLine, maxWidth)
    }
    return firstLine + ELLIPSIS
  }
  if (stringWidth(str) <= maxWidth) return str
  return truncateToWidth(str, maxWidth)
}

export { default as wrapText } from '../ink/wrap-text.js'
