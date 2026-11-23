import { resolveModelCapabilities } from '../../models/facts/capabilities.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'

function leadingInt(component: string): number | null {
  if (!/^[+-]?\d/.test(component)) return null
  const value = parseInt(component, 10)
  return Number.isFinite(value) ? value : null
}

export function parsePDFPageRange(pages: string): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) return null
  const parts = trimmed.split('-')
  if (parts.length === 1) {
    const page = leadingInt(parts[0]!)
    if (page === null || page < 1) return null
    return { firstPage: page, lastPage: page }
  }
  if (parts.length === 2) {
    const firstPage = leadingInt(parts[0]!)
    if (firstPage === null || firstPage < 1) return null
    if (parts[1] === '') {
      return { firstPage, lastPage: Infinity }
    }
    const lastPage = leadingInt(parts[1]!)
    if (lastPage === null || lastPage < firstPage) return null
    return { firstPage, lastPage }
  }
  return null
}

export function isPDFSupported(model?: string): boolean {
  return resolveModelCapabilities(model ?? getEngineModel()).media.pdf
}

export function isPDFExtension(ext: string): boolean {
  const normalized = ext.toLowerCase()
  return normalized === 'pdf' || normalized === '.pdf'
}
