
import React, { type PropsWithChildren } from 'react'
import Box, { type Props as BoxProps } from './Box.js'

type Props = PropsWithChildren<
  Omit<BoxProps, 'noSelect'> & {
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
