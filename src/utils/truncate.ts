import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'

const ELLIPSIS = '…'

function takeCells(text: string, cells: number, tail = false): string {
  const segments = getGraphemeSegmenter().segment(text)
  let at = tail ? text.length : 0
  while (tail ? at > 0 : at < text.length) {
    const cluster = segments.containing(tail ? at - 1 : at)!
    const width = stringWidth(cluster.segment)
    if (width > cells) break
    cells -= width
    at = tail ? cluster.index : cluster.index + cluster.segment.length
  }
  return tail ? text.slice(at) : text.slice(0, at)
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  return maxWidth <= 1 ? ELLIPSIS : takeCells(text, maxWidth - 1) + ELLIPSIS
}

export function truncateStartToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  return maxWidth <= 1 ? ELLIPSIS : ELLIPSIS + takeCells(text, maxWidth - 1, true)
}

export function truncateKeepingTail(text: string, maxWidth: number, keepTail?: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return ELLIPSIS
  const split = text.lastIndexOf(' — ')
  const tail = keepTail !== undefined ? takeCells(text, keepTail, true) : split < 0 ? '' : text.slice(split)
  const room = maxWidth - stringWidth(tail) - 1
  if (room <= 0) return truncateStartToWidth(ELLIPSIS + tail, maxWidth)
  const head = text.slice(0, text.length - tail.length)
  return takeCells(head, room).trimEnd() + ELLIPSIS + tail
}

export function truncateToWidthNoEllipsis(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  return maxWidth <= 0 ? '' : takeCells(text, maxWidth)
}

export function truncatePathMiddle(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path
  if (maxLength < 5) return truncateToWidth(path, maxLength)
  const split = Math.max(0, path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(split)
  const room = maxLength - 1 - stringWidth(name)
  return room <= 0 ? truncateStartToWidth(path, maxLength) : truncateToWidthNoEllipsis(path.slice(0, split), room) + ELLIPSIS + name
}

export function truncate(str: string, maxWidth: number, singleLine = false): string {
  const newline = singleLine ? str.indexOf('\n') : -1
  if (newline < 0) return truncateToWidth(str, maxWidth)
  const line = str.slice(0, newline)
  return stringWidth(line) + 1 > maxWidth ? truncateToWidth(line, maxWidth) : line + ELLIPSIS
}

export { default as wrapText } from '../ink/wrap-text.js'
