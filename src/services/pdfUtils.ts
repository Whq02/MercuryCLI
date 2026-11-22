import { resolveModelCapabilities } from '../utils/model/capabilities.js'
import { getEngineModel } from './model/model.js'
import { notBuilt } from '../pi/holes.js'

function leadingInt(component: string): number | null {
  if (!/^[+-]?\d/.test(component)) return null
  const value = parseInt(component, 10)
  return Number.isFinite(value) ? value : null
}

export function parsePDFPageRange(pages: string): { firstPage: number; lastPage: number } | null {
  return notBuilt('src/services/pdfUtils.ts:13')
}

export function isPDFSupported(model?: string): boolean {
  return resolveModelCapabilities(model ?? getEngineModel()).media.pdf
}

export function isPDFExtension(ext: string): boolean {
  return notBuilt('src/services/pdfUtils.ts:37')
}
