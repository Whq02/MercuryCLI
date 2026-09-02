import chalk from 'chalk'
import { CHALK_DISABLED_FOR_NO_COLOR } from '../../ink/colorize.js'
import type { RecessTransform } from '../../ink/cell-grid.js'
import type { MercuryThemeTokens } from '../mercuryTokens.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

export function recessBackdropEnabled(): boolean {
  if (flagEnv('MERCURY_RECESS') === '0') return false
  if (CHALK_DISABLED_FOR_NO_COLOR) return false
  return chalk.level >= 2
}

export function recessTargetFor(tokens: MercuryThemeTokens): RecessTransform | null {
  if (!recessBackdropEnabled()) return null
  const canvas = parseHex(tokens.canvas) ?? parseHex(tokens.surface0)
  const ink = parseHex(tokens.textPrimary)
  if (!canvas || !ink) return null
  return { canvas, ink, quantize256: chalk.level === 2 }
}
