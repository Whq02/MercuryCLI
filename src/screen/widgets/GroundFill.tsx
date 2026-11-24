import * as React from 'react'
import { Box } from '../themedRenderer.js'
import { TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js'
import { estateGroundBg } from '../theme/mercuryTokens.js'
import { useMercuryTokens } from './useMercuryTokens.js'

export function GroundFill({ children }: { children: React.ReactNode }): React.ReactNode {
  const tokens = useMercuryTokens()
  const size = React.useContext(TerminalSizeContext)
  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      backgroundColor={estateGroundBg(tokens)}
    >
      {children}
    </Box>
  )
}
