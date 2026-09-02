
import React from 'react'
import { Text } from '../../ink.js'

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
