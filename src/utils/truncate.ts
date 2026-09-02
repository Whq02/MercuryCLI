import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'

/**
 * Display-width-aware, grapheme-safe truncation and wrapping. Everything
 * here measures in terminal display columns, not code units, and splits on
 * grapheme cluster boundaries so emoji, CJK characters and surrogate pairs
 * are never broken. The cut positions are load-bearing for the composer
 * surfaces that consume these through the format barrel — treat the
 * boundaries as fixed behaviour.
 */

const ELLIPSIS = '…'

function graphemes(text: string): string[] {
  const segments: string[] = []
  for (const segment of getGraphemeSegmenter().segment(text)) {
    segments.push(segment.segment)
  }
  return segments
}

/** End-truncates to the width budget with a trailing ellipsis. */
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

/** Start-truncates to the width budget with a leading ellipsis. */
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

/** End-truncates using the full budget, for callers that supply their own separator. */
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

/**
 * Middle-truncates a path, preserving the directory context and the whole
 * filename (the last separator-delimited segment, including its leading
 * separator). Both separators split — a Windows display spelling once fell
 * to `lastSlash === -1`, degraded to a leading ellipsis, and lost the root
 * context middle truncation exists to preserve (field F-5.1; the
 * exampleCommands separator pattern).
 */
export function truncatePathMiddle(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path
  if (maxLength <= 0) return ELLIPSIS
  if (maxLength < 5) return truncateToWidth(path, maxLength)

  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const filename = lastSlash === -1 ? path : path.slice(lastSlash)
  const directory = lastSlash === -1 ? '' : path.slice(0, lastSlash)
  const filenameWidth = stringWidth(filename)

  // A filename that (almost) fills the budget leaves no room for context:
  // fall back to start-truncating the whole path.
  if (filenameWidth >= maxLength - 1) {
    return truncateStartToWidth(path, maxLength)
  }
  const directoryBudget = maxLength - 1 - filenameWidth
  const truncatedDirectory = truncateToWidthNoEllipsis(directory, directoryBudget)
  return truncatedDirectory + ELLIPSIS + filename
}

/**
 * General truncation; with the single-line flag, content after the first
 * newline is dropped and the cut is marked with an ellipsis even when the
 * kept line would have fitted bare.
 */
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

// Back-compat seam: the derived format.ts barrel re-exports wrapText from
// this module; the implementation is owned by ink and this alias routes to
// it (smallest compiling surface, recorded under stubsPendingImporterRewrite
// — the format.ts rewrite retires the chain).
export { default as wrapText } from '../ink/wrap-text.js'
