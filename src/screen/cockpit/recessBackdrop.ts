import { colorDepth } from '../renderer/colorize.js'
import type { RecessTransform } from '../renderer/cell-grid.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'

function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

export function recessBackdropEnabled(): boolean {
  if (!flagEnabled('MERCURY_RECESS')) return false
  const depth = colorDepth()
  return depth === 'truecolor' || depth === '256'
}

export function recessTargetFor(tokens: MercuryThemeTokens): RecessTransform | null {
  if (!recessBackdropEnabled()) return null
  const canvas = parseHex(tokens.canvas) ?? parseHex(tokens.surface0)
  const ink = parseHex(tokens.textPrimary)
  if (!canvas || !ink) return null
  return { canvas, ink, quantize256: colorDepth() === '256' }
}
