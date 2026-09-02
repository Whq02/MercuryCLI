// Fence children off from alternate-screen selection: gutters, sigils and
// bullets stay visually unchanged while a drag copies clean content.

import React, { type PropsWithChildren } from 'react'
import Box, { type Props as BoxProps } from './Box.js'

type Props = PropsWithChildren<
  Omit<BoxProps, 'noSelect'> & {
    /** Widen the exclusion from column 0 to the box's right edge. */
    readonly fromLeftEdge?: boolean
  }
>

export function NoSelect({
  children,
  fromLeftEdge = false,
  ...boxProps
}: Props): React.ReactNode {
  return (
    <Box {...boxProps} noSelect={fromLeftEdge ? 'from-left-edge' : true}>
      {children}
    </Box>
  )
}
