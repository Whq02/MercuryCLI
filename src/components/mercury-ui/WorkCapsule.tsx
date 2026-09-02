import * as React from 'react'
import { createContext } from 'react'
import { Box } from '../../ink.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { useMercuryTokens } from './useMercuryTokens.js'


export const WorkCapsuleContext = createContext<boolean>(false)

export function WorkCapsule({
  active,
  width,
  children,
}: {
  active: boolean
  width: number
  children: React.ReactNode
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const outer = React.useContext(TerminalSizeContext)
  const dressed = active && width >= 24
  const innerW = dressed ? width - 4 : width
  const sizeVal = React.useMemo(
    () => (dressed && outer ? { columns: innerW, rows: outer.rows } : outer),
    [dressed, outer, innerW],
  )
  return (
    <WorkCapsuleContext.Provider value={dressed}>
      <Box
        flexDirection="column"
        flexShrink={0}
        width={width}
        borderStyle={dressed ? 'round' : undefined}
        borderColor={dressed ? tokens.borderStrong : undefined}
        paddingX={dressed ? 1 : 0}
      >
        {
}
        <Box flexDirection="column" width={innerW} flexShrink={0}>
          <TerminalSizeContext.Provider value={sizeVal}>
            {children}
          </TerminalSizeContext.Provider>
        </Box>
      </Box>
    </WorkCapsuleContext.Provider>
  )
}
