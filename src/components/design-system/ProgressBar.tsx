// Sub-cell block progress bar: full blocks for the whole part, one partial
// cell from a nine-step ramp, blanks for the rest. Total cells always equal
// the requested width; the ratio is clamped into [0, 1].

import React from 'react'
import { Text } from '../../ink.js'

/** Blank through the eight rising eighth-blocks. */
const PARTIAL_RAMP = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const

export function ProgressBar({
  ratio,
  width,
  fillColor,
  emptyColor,
}: {
  ratio: number
  width: number
  fillColor?: string
  emptyColor?: string
}): React.ReactNode {
  // Narrow-geometry floor: callers derive width from live terminal columns,
  // so a tiny terminal can hand a negative or non-finite value — the bar
  // renders empty then, never throws.
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const clamped = Math.min(1, Math.max(0, ratio))
  const cells = clamped * safeWidth
  const full = Math.floor(cells)
  let bar = '█'.repeat(full)
  if (full < safeWidth) {
    const fraction = cells - full
    bar += PARTIAL_RAMP[Math.floor(fraction * 9)] ?? ' '
    bar += ' '.repeat(Math.max(0, safeWidth - full - 1))
  }
  return (
    <Text color={fillColor} backgroundColor={emptyColor}>
      {bar}
    </Text>
  )
}

export default ProgressBar
