import * as React from 'react'
import { Text } from '../themedRenderer.js'
import type { Theme } from '../theme/theme.js'
import type { HexColor } from '../renderer/styles.js'

type Props = {
  char: string
  index: number
  glimmerIndex: number
  messageColor: keyof Theme | HexColor
  shimmerColor: keyof Theme | HexColor
}

export function ShimmerChar({
  char,
  index,
  glimmerIndex,
  messageColor,
  shimmerColor,
}: Props): React.ReactNode {
  const distance = Math.abs(index - glimmerIndex)
  const isShimmer = distance === 0 || distance === 1
  return <Text color={isShimmer ? shimmerColor : messageColor}>{char}</Text>
}
