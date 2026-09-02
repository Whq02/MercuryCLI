import { resolveModelCapabilities } from './model/capabilities.js'
import { getMainLoopModel } from './model/model.js'

/**
 * PDF page-range parsing, the document-extension check, and the
 * model-capability gate for inline documents.
 */

export const DOCUMENT_EXTENSIONS: Set<string> = new Set(['pdf'])

/** The lenient base-10 leading-integer reading: `5abc` is 5; a non-digit start is non-numeric. */
function leadingInt(component: string): number | null {
  if (!/^[+-]?\d/.test(component)) return null
  const value = parseInt(component, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * 1-indexed and inclusive: `5`, `1-10`, or the open-ended `3-` (upper bound
 * infinity). The open-ended form is tested BEFORE an interior separator is
 * looked for; a closed range splits at the FIRST interior separator.
 */
export function parsePDFPageRange(pages: string): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (trimmed === '') return null
  if (trimmed.endsWith('-') && trimmed.length > 1) {
    const first = leadingInt(trimmed.slice(0, -1))
    if (first === null || first < 1) return null
    return { firstPage: first, lastPage: Infinity }
  }
  const separator = trimmed.indexOf('-', 1)
  if (separator === -1) {
    const single = leadingInt(trimmed)
    if (single === null || single < 1) return null
    return { firstPage: single, lastPage: single }
  }
  const first = leadingInt(trimmed.slice(0, separator))
  const last = leadingInt(trimmed.slice(separator + 1))
  if (first === null || last === null || first < 1 || last < 1 || last < first) return null
  return { firstPage: first, lastPage: last }
}

/** Whether PDF document blocks reach the given model (the capability
 *  record decides — Anthropic-lane models only). Callers that know their
 *  turn's model pass it; the main-loop model is only the fallback. */
export function isPDFSupported(model?: string): boolean {
  return resolveModelCapabilities(model ?? getMainLoopModel()).media.pdf
}

/** With or without a leading dot, case-insensitive. */
export function isPDFExtension(ext: string): boolean {
  return DOCUMENT_EXTENSIONS.has(ext.replace(/^\./, '').toLowerCase())
}
