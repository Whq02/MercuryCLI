import { resolveModelCapabilities } from './model/capabilities.js'
import { getMainLoopModel } from './model/model.js'


export const DOCUMENT_EXTENSIONS: Set<string> = new Set(['pdf'])

function leadingInt(component: string): number | null {
  if (!/^[+-]?\d/.test(component)) return null
  const value = parseInt(component, 10)
  return Number.isFinite(value) ? value : null
}

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

export function isPDFSupported(model?: string): boolean {
  return resolveModelCapabilities(model ?? getMainLoopModel()).media.pdf
}

export function isPDFExtension(ext: string): boolean {
  return DOCUMENT_EXTENSIONS.has(ext.replace(/^\./, '').toLowerCase())
}
